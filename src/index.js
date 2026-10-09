/**
 * Host half of `dsh-session-delete`.
 *
 * DSH ships archive but no delete: session persistence is append-only, the
 * Workspace registry accounts membership, and the projection cache holds one
 * checkpoint document per Session. This plugin composes the existing public
 * services into one "delete" operation and exposes it as an authenticated
 * browser route the client half calls:
 *
 * 1. resolve the Session (live store first, then a fresh persistence listing)
 *    and the exact artifact paths the persistence backend reports;
 * 2. stop a running turn through the registry's own archive admission seam;
 * 3. unaccount it durably (Workspace membership, archive set, pin set);
 * 4. remove its log directory and projection checkpoint permanently, after
 *    quarantining the directory under the sessions root so a failure part-way
 *    can never leave a half-deleted Session in place;
 * 5. tell every browser Session list to drop the row (`api-session/removed`,
 *    an event already on the forwarded Remote event allowlist).
 *
 * `modifyOnly` performs the resolution and the validation but reports the paths
 * it would remove without touching the filesystem, which is what the
 * confirmation dialog shows.
 *
 * @module dsh-session-delete
 */

import { lstat, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// ── stable names ───────────────────────────────────────────────────────────

/** Absolute pathname this plugin registers its browser route under. */
export const SESSION_DELETE_PATH = '/api/session.delete';

/**
 * Header a browser caller must send. The Host's trust fence already rejects
 * cross-site origins, so this is the second lock on the same door: an ordinary
 * HTML form or a plain link cannot set a custom header, so a cross-site
 * navigation can never reach the destructive branch. A caller with no Origin
 * header at all — a native tool posting to loopback — is exempt, because the
 * fence has already authenticated it as the operator.
 */
const CONFIRMATION_HEADER = 'x-dsh-session-delete-confirmation';

/** The confirmation header's required value. */
const CONFIRMATION_VALUE = 'delete-session';

/** Bound on the request body, read before parsing so a large post cannot buffer. */
const MAX_REQUEST_BYTES = 8 * 1024;

/** Session ids are path segments when the layout is derived, so the shape is pinned. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

/** Http status the route answers for each typed refusal. */
const STATUS_BY_CODE = {
  'session-delete/not-found': 404,
  'session-delete/running': 409,
  'session-delete/unsafe-location': 409,
  'session-delete/internal': 500,
};

// ── typed refusals ─────────────────────────────────────────────────────────

/** A delete request this plugin refuses with a stable code the client renders. */
export class SessionDeleteError extends Error {
  /**
   * @param code - stable refusal code.
   * @param message - operator-facing detail.
   * @param status - Http status the route answers.
   */
  constructor(code, message, status) {
    super(message);
    this.name = 'SessionDeleteError';
    this.code = code;
    this.status = status;
  }
}

/**
 * One refused delete: the Session is unknown, is running, or the operation
 * failed.
 * @param code - stable refusal code.
 * @param message - detail text.
 * @returns the typed error.
 */
function refuse(code, message) {
  return new SessionDeleteError(code, message, STATUS_BY_CODE[code] ?? 500);
}

// ── path derivations (mirrors of the persistence + storage layouts) ────────

/**
 * Resolve the DeepSeek Harness home exactly as `dsh-home-paths` does, without
 * taking a dependency on a package whose peer range is pinned to one DSH
 * release.
 * @returns the absolute harness home.
 */
function dshHome() {
  const fromEnv = process.env['DSH_HOME'];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return resolve(fromEnv);
  return join(homedir(), '.dsh');
}

/** Root of the JSONL session-persistence artifact tree. */
const SESSIONS_ROOT = join(dshHome(), 'sessions');

/** Root of the per-record `session_projcache` storage domain. */
const PROJ_CACHE_ROOT = join(dshHome(), 'storages', 'session_projcache', 'sessions');

/**
 * Prefix of the quarantine directory one permanent delete stages into. It sits
 * beside the project directories under the sessions root, so the staged move is
 * a same-volume rename, and any survivor is obvious to an operator.
 */
const QUARANTINE_PREFIX = '.dsh-session-delete-';

/**
 * Encode one string as a single path segment, matching the persistence
 * backend's own encoding so a derived path lands on the artifact it names.
 * @param raw - the string to encode (must be non-empty).
 * @returns the escaped single path segment.
 */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/u.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/**
 * Build the human-navigable project directory key for one cwd, matching the
 * persistence backend: separators collapse to one `-`, unsafe code units use
 * the same `~XXXX` escape, and the result is bounded for filesystem limits.
 * @param cwd - the Session's project directory.
 * @returns one filesystem-safe project directory name.
 */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/u.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/u, '') || 'root').slice(0, 251)}--`;
}

/**
 * The directory a Session owns under the sessions root.
 * @param cwd - the Session's project directory, absent for a header without one.
 * @param id - the Session id.
 * @returns the absolute Session directory.
 */
function sessionDirOf(cwd, id) {
  return join(SESSIONS_ROOT, projectKey(cwd ?? '_no-cwd'), encodeSegment(id));
}

// ── location resolution and containment ────────────────────────────────────

/**
 * Whether `target` is a strict descendant of `root`.
 * @param root - the containment root.
 * @param target - the candidate path.
 * @returns true when the relative path stays inside the root.
 */
function inside(root, target) {
  const path = relative(root, target);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/**
 * Ask the persistence backend where the Session's log actually is. The backend
 * owns its physical layout, so this is preferred over any derivation here and
 * keeps working when the format generation changes.
 * @param handle - the resolved services.
 * @param id - the Session id.
 * @returns the absolute log path, or `undefined` when the backend cannot answer.
 */
async function backendLogPath(handle, id) {
  const persistence = handle.persistence;
  if (typeof persistence?.resolveCurrentLog !== 'function') return undefined;
  try {
    const path = await persistence.resolveCurrentLog(id);
    return typeof path === 'string' && path.length > 0 ? path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decide the two paths one delete touches: the Session's own directory (its log
 * and any future Session-local artifact) and the projection checkpoint.
 *
 * The directory comes from the persistence backend whenever it can answer, and
 * from this plugin's replica of the layout otherwise; the checkpoint path is
 * always derived, because the store domain is not addressable from a plugin.
 *
 * A backend path is only accepted when it sits directly under one project
 * directory of the configured sessions root, so a stale or hostile answer can
 * never point the recursive move at an unrelated tree.
 * @param handle - the resolved services.
 * @param id - the Session id.
 * @param header - the Session's header, which supplies the cwd fallback key.
 * @returns the Session directory and the checkpoint path.
 * @throws {SessionDeleteError} `session-delete/unsafe-location` when the backend
 *   answered with a path outside the sessions root.
 */
async function resolveArtifacts(handle, id, header) {
  const cacheFile = join(PROJ_CACHE_ROOT, `${encodeSegment(id)}.json`);
  const derived = sessionDirOf(header.cwd, id);
  const fromBackend = await backendLogPath(handle, id);
  if (fromBackend === undefined) return { sessionDir: derived, cacheFile, source: 'derived' };
  const root = resolve(SESSIONS_ROOT);
  const transcript = resolve(fromBackend);
  const segments = relative(root, transcript).split(sep).filter(Boolean);
  if (!isAbsolute(root) || !inside(root, transcript) || segments.length !== 3) {
    throw refuse('session-delete/unsafe-location', `session '${id}' resolves outside the configured sessions root; nothing was deleted`);
  }
  return { sessionDir: join(root, segments[0], segments[1]), cacheFile, source: 'backend' };
}

/**
 * Prove the resolved Session directory is a real directory this delete owns,
 * not a symlink into somewhere else, and return the identity to re-check after
 * the quarantine move. Re-checked immediately before the move, because the
 * resolution and the move are separated by awaits.
 * @param sessionDir - the resolved Session directory.
 * @returns the pre-move identity, or `undefined` to remove nothing.
 */
async function ownedDirectoryIdentity(sessionDir) {
  try {
    const entry = await lstat(sessionDir, { bigint: true });
    if (entry.isSymbolicLink() || !entry.isDirectory()) return undefined;
    const [real, parent] = await Promise.all([realpath(sessionDir), realpath(dirname(sessionDir))]);
    // A junction anywhere in the chain would make the recursive remove leave
    // the sessions root, so the real parent must be the real project directory.
    if (dirname(real) !== parent || !inside(resolve(SESSIONS_ROOT), real)) return undefined;
    return { dev: entry.dev, ino: entry.ino, size: entry.size, birthtimeNs: entry.birthtimeNs };
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    return undefined;
  }
}

/**
 * Whether two `lstat` identities describe the same object. Used to prove the
 * quarantined directory is the one this delete staged, not a replacement.
 * @param before - the identity captured before the move.
 * @param after - the identity captured after it.
 * @returns true when every recorded field matches.
 */
function sameIdentity(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.birthtimeNs === after.birthtimeNs;
}

/**
 * Whether a path exists.
 * @param path - the path to test.
 * @returns true when it exists.
 */
async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Remove one Session's directory permanently.
 *
 * The directory is first renamed into a quarantine directory beside the project
 * directories — same volume, so the move is atomic — and its identity is
 * re-checked there. Only then is it removed. That order is what makes a failure
 * safe: a half-removed tree is never left where DSH would keep reading it, and
 * a directory that changed identity under the delete is put back untouched.
 * @param sessionDir - the validated Session directory.
 * @param identity - the identity captured before the move.
 * @returns the path that was removed, or `undefined` when it did not exist.
 * @throws {SessionDeleteError} `session-delete/unsafe-location` for a changed
 *   identity, `session-delete/internal` for a failed removal.
 */
async function removeSessionDirectory(sessionDir, identity) {
  if (!await pathExists(sessionDir)) return undefined;
  const quarantineRoot = await mkdtemp(join(resolve(SESSIONS_ROOT), QUARANTINE_PREFIX));
  const staged = join(quarantineRoot, basename(sessionDir));
  try {
    await rename(sessionDir, staged);
  } catch (error) {
    await rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined);
    throw refuse('session-delete/internal', `cannot remove the session directory: ${messageOf(error)}`);
  }
  const after = await lstat(staged, { bigint: true });
  if (after.isSymbolicLink() || !sameIdentity(identity, after)) {
    // Put it back exactly where it was: something swapped it mid-delete.
    await rename(staged, sessionDir).catch(() => undefined);
    await rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined);
    throw refuse('session-delete/unsafe-location', 'the session directory changed identity during the delete; nothing was removed');
  }
  try {
    await rm(staged, { recursive: true, force: false });
  } catch (error) {
    throw refuse('session-delete/internal', `the session was unloaded but its directory could not be removed (${messageOf(error)}); it is staged at ${staged}`);
  }
  if (await pathExists(staged)) {
    throw refuse('session-delete/internal', `the session directory survived removal; it is staged at ${staged}`);
  }
  await rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined);
  return sessionDir;
}

// ── services the operation composes ────────────────────────────────────────

/**
 * Read the services a delete needs. Members stay optional: a deployment
 * without one degrades to a warning instead of failing the whole operation.
 * @param ctx - the composed host context.
 * @returns the service handle.
 */
function services(ctx) {
  return {
    registry: ctx.get('workspaceRegistry'),
    sessions: ctx.get('sessions'),
    agents: ctx.get('agents'),
    persistence: ctx.get('sessionPersistence'),
  };
}

/**
 * Whether an Agent currently runs a turn for this Session.
 * @param handle - the resolved services.
 * @param id - the Session id.
 * @returns true when the Session's work is in flight.
 */
function isRunning(handle, id) {
  const agent = handle.agents?.get(id);
  if (agent === undefined || agent === null) return false;
  return agent.status === 'running';
}

/**
 * Resolve one Session and refuse a definite miss: the live store first, then a
 * fresh persistence listing, then the header index the registry maintains.
 * @param handle - the resolved services.
 * @param id - the Session id.
 * @returns the Session's header.
 * @throws {SessionDeleteError} `session-delete/not-found` for a definite miss.
 */
async function resolveHeader(handle, id) {
  const live = handle.sessions?.get(id);
  if (live !== undefined) return live.header;
  if (handle.persistence !== undefined) {
    const snapshot = (await handle.persistence.list()).find((entry) => entry.header.id === id);
    if (snapshot !== undefined) return snapshot.header;
  }
  const indexed = handle.registry?.list?.().find((workspace) => workspace.sessionIds.includes(id));
  if (indexed !== undefined) return { id, cwd: indexed.path };
  throw refuse('session-delete/not-found', `session '${id}' is not live and session persistence holds no such session`);
}

/**
 * Stop a running Session's work through the registry's own archive admission
 * seam — the same stop the "stop and archive" confirmation uses — and then put
 * the archive marker straight back. Nothing else about the Session changes, so
 * this is a safe way to make a live Session deletable without reaching into the
 * store's private teardown path.
 * @param handle - the resolved services.
 * @param id - the Session id.
 * @param report - collector for non-fatal problems.
 * @returns whether the Session's work was stopped.
 */
async function stopRunningWork(handle, id, report) {
  const registry = handle.registry;
  if (typeof registry?.archiveSession !== 'function' || typeof registry.unarchiveSession !== 'function') {
    report.push('the workspace registry exposes no stop seam');
    return false;
  }
  try {
    await registry.archiveSession(id, { stopActivity: true });
  } catch (error) {
    report.push(`stopping the running turn failed: ${messageOf(error)}`);
    return false;
  }
  try {
    await registry.unarchiveSession(id);
  } catch (error) {
    // The archive marker is reconciled again at the end of the delete, so a
    // failure here is reported and not fatal.
    report.push(`clearing the temporary archive marker failed: ${messageOf(error)}`);
  }
  return true;
}

/**
 * Drop the Session from durable Workspace accounting and from the
 * registry-global archive and pin sets. Membership is removed through the
 * entity's own write path, which also stamps the Workspace and publishes the
 * change the browser sidebar follows; the archive and pin sets are filtered
 * through the registry's serialized operation queue.
 * @param handle - the resolved services.
 * @param id - the Session id.
 * @param report - collector for non-fatal problems.
 */
async function unaccount(handle, id, report) {
  const registry = handle.registry;
  if (registry === undefined) {
    report.push('workspace registry is unavailable: the session keeps its workspace slot until restart');
    return;
  }
  try {
    if (registry.archivedSessionIds.includes(id)) await registry.unarchiveSession(id);
    if (registry.pinnedSessionIds.includes(id)) await registry.unpinSession(id);
  } catch (error) {
    report.push(`clearing the archive or pin set failed: ${messageOf(error)}`);
  }
  try {
    for (const workspace of registry.list()) {
      if (!workspace.sessionIds.includes(id)) continue;
      await workspace.detachSession(id);
    }
  } catch (error) {
    report.push(`removing the workspace slot failed: ${messageOf(error)}`);
  }
}

/**
 * Remove the Session's on-disk footprint permanently: its log directory and its
 * projection checkpoint document.
 *
 * The directory is the one artifact that can hold anything else the Session
 * owns, so it goes through the quarantine path with a re-checked identity. The
 * checkpoint is a single file this plugin names itself under a root it owns, so
 * removing it cannot follow a link out of that root.
 * @param sessionDir - the validated Session directory.
 * @param cacheFile - the projection checkpoint path.
 * @param identity - the directory identity captured before any accounting change.
 * @returns the paths that were removed.
 * @throws {SessionDeleteError} `session-delete/unsafe-location` when the
 *   directory changed identity under the delete.
 */
async function discardArtifacts(sessionDir, cacheFile, identity) {
  const removedDirectory = await removeSessionDirectory(sessionDir, identity);
  await rm(cacheFile, { force: true });
  return [removedDirectory ?? sessionDir, cacheFile];
}

/**
 * Delete one Session permanently: unaccount it, remove its artifacts, and drop
 * its row from every open browser Session list. A Session whose turn is running
 * is stopped first through the registry's archive admission seam.
 *
 * The order is load-bearing. Every check that can refuse — identity, location,
 * and the safety of removing a running Session — runs before the first durable
 * mutation, so a refusal leaves the Session exactly as it was, with no
 * half-taken workspace or archive state to repair by hand.
 * @param ctx - the composed host context.
 * @param options - the request.
 * @param options.sessionId - the Session to delete.
 * @param options.modifyOnly - report the plan without touching anything.
 * @returns the durable outcome.
 * @throws {SessionDeleteError} for a refused delete.
 */
export async function deleteSession(ctx, options) {
  const id = options.sessionId;
  if (!SESSION_ID_PATTERN.test(id)) {
    throw refuse('session-delete/internal', 'sessionId must match [A-Za-z0-9_-]{1,128}');
  }
  const handle = services(ctx);
  if (handle.sessions === undefined && handle.persistence === undefined) {
    throw refuse('session-delete/internal', 'session delete is unavailable: the deployment mounts neither a Session store nor session persistence');
  }
  const header = await resolveHeader(handle, id);
  const artifacts = await resolveArtifacts(handle, id, header);
  const candidate = await ownedDirectoryIdentity(artifacts.sessionDir);
  if (candidate === undefined) {
    throw refuse('session-delete/unsafe-location', `session '${id}': its directory is a symlink or leaves the sessions root; nothing was removed`);
  }
  const warnings = [];
  const wasRunning = isRunning(handle, id);
  if (wasRunning && options.modifyOnly !== true) {
    await stopRunningWork(handle, id, warnings);
    if (isRunning(handle, id)) {
      throw refuse('session-delete/running', `session '${id}' is still live after its turn was stopped: no files were deleted, and the session is now archived — unarchive it from the sidebar filter and retry once its turn has settled`);
    }
  } else if (wasRunning) {
    warnings.push('the session is running: confirming will stop its turn before deleting');
  }
  if (options.modifyOnly === true) {
    const plan = {
      sessionId: id,
      cwd: header.cwd ?? null,
      locationSource: artifacts.source,
      modifyOnly: true,
      paths: [artifacts.sessionDir, artifacts.cacheFile],
      warnings,
    };
    for (const warning of warnings) ctx.logger.warn(`session-delete: ${warning}`);
    ctx.logger.info(`session-delete: planned session '${id}'`);
    return plan;
  }
  await unaccount(handle, id, warnings);
  const paths = await discardArtifacts(artifacts.sessionDir, artifacts.cacheFile, candidate);
  // Take the row out of every open Session list. This is the same event the
  // controller emits on disposal, so the browser applies its own removal rules
  // (subagent rows degrade to unavailable instead of vanishing).
  ctx.emit('api-session/removed', id);
  const outcome = {
    sessionId: id,
    cwd: header.cwd ?? null,
    locationSource: artifacts.source,
    modifyOnly: false,
    paths,
    warnings,
  };
  for (const warning of warnings) ctx.logger.warn(`session-delete: ${warning}`);
  ctx.logger.info(`session-delete: permanently deleted session '${id}'`);
  return outcome;
}

/**
 * Answer one browser request to the delete route.
 *
 * The checks run in the order a browser can defeat them: method, media type,
 * the confirmation header (which only script can set), then the body. The body
 * is measured before it is parsed, so an oversized post is refused instead of
 * buffered.
 * @param ctx - the composed host context.
 * @param request - the browser request.
 * @returns the JSON response.
 */
export async function sessionDeleteResponse(ctx, request) {
  if (request.method !== 'POST') return json({ error: 'the session delete route accepts POST only' }, 405);
  const mediaType = (request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') return json({ error: 'the session delete route requires application/json' }, 415);
  const origin = request.headers.get('origin');
  if (origin !== null) {
    // A browser always sends Origin. The Host's own fence already rejects a
    // host it does not serve; this repeats the same-origin comparison for the
    // case where the deployment widened its trusted authorities, and the
    // confirmation header (which no form or link can set) rules out a
    // navigation-driven request.
    const host = request.headers.get('host');
    if (host === null || origin !== `http://${host}` || request.headers.get(CONFIRMATION_HEADER) !== CONFIRMATION_VALUE) {
      return json({ error: `a browser request must be same-origin and send ${CONFIRMATION_HEADER}: ${CONFIRMATION_VALUE}` }, 403);
    }
  }
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return json({ error: 'the session delete request body is too large' }, 413);
  }
  let text;
  try {
    text = await request.text();
  } catch {
    return json({ error: 'the session delete request body could not be read' }, 400);
  }
  if (text.length > MAX_REQUEST_BYTES) return json({ error: 'the session delete request body is too large' }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'request body must be JSON' }, 400);
  }
  const sessionId = typeof body === 'object' && body !== null ? body.sessionId : undefined;
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    return json({ error: 'sessionId must be a non-empty [A-Za-z0-9_-] string' }, 400);
  }
  try {
    const value = await deleteSession(ctx, {
      sessionId,
      ...(body.modifyOnly === true ? { modifyOnly: true } : {}),
    });
    return json({ ok: true, value }, 200);
  } catch (error) {
    if (error instanceof SessionDeleteError) return json({ ok: false, error: { code: error.code, message: error.message } }, error.status);
    ctx.logger.error(`session-delete: session '${sessionId}' failed: ${messageOf(error)}`);
    return json({ ok: false, error: { code: 'session-delete/internal', message: messageOf(error) } }, 500);
  }
}

/**
 * Serialize one JSON response.
 * @param value - the payload.
 * @param status - the Http status.
 * @returns the response.
 */
function json(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * Read a message out of an unknown thrown value.
 * @param error - the thrown value.
 * @returns its message text.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

// ── plugin face ────────────────────────────────────────────────────────────

/** Stable Cordis plugin name. */
export const name = 'session-delete';

/**
 * Services required before the route can be registered. Every other service
 * the operation composes is read optionally, so a deployment that mounts this
 * plugin without a Workspace registry still answers.
 */
export const inject = ['connection'];

/**
 * Register the authenticated browser route.
 *
 * This runs inside the plugin's own fiber, and a throw here fails the fiber —
 * which the Web boot audit treats as a blocked boot, so a working Harness would
 * refuse to start until the operator disables third-party plugins. The route is
 * the ONLY thing this half adds at mount time, so the whole body is guarded:
 * a deployment that lacks the seam loses the menu's Host call and logs why,
 * rather than taking the application down with it.
 * @param ctx - the host context carrying the Connection route registry.
 */
export function apply(ctx) {
  try {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
    const register = connection?.fetch?.register;
    if (typeof register !== 'function') {
      ctx.logger.warn('session-delete: the Connection fetch route registry is unavailable; the delete route is not registered');
      return;
    }
    // `register` binds the route to this fiber's effect itself, so it is not
    // wrapped again: the returned disposer belongs to that same effect.
    register.call(connection.fetch, {
      path: SESSION_DELETE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => sessionDeleteResponse(ctx, request),
    });
  } catch (error) {
    ctx.logger.error(`session-delete: registering the delete route failed; the route is not registered: ${messageOf(error)}`);
  }
}

export { PROJ_CACHE_ROOT, SESSIONS_ROOT, SESSION_ID_PATTERN, encodeSegment, projectKey, sessionDirOf };
