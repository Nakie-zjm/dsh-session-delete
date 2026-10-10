/**
 * Host-half end-to-end check on a throwaway harness home.
 *
 * `DSH_HOME` is redirected to a temp directory before the module under test is
 * imported, so every derived root (sessions, projection cache, quarantine)
 * points inside that directory and the real `~/.dsh` is never touched. The test
 * then builds a Session that looks exactly like the persistence backend's
 * artifact layout and runs the real `deleteSession` against stub services.
 *
 * Usage:
 *   node test/host-half.mjs
 *
 * @module dsh-session-delete/test/host-half
 */

import { existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Redirect the harness home BEFORE the module computes its roots.
const home = mkdtempSync(join(tmpdir(), 'dsh-session-delete-test-'));
process.env['DSH_HOME'] = home;

const plugin = await import(pathToFileURL(join(here, '..', 'src', 'index.js')).href);

const checks = [];

/**
 * Record one named check.
 * @param label - what was checked.
 * @param ok - its outcome.
 * @param detail - optional evidence.
 */
function check(label, ok, detail) {
  checks.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`);
}

/** The project directory the fixture Session claims. */
const CWD = 'D:\\code\\fixture-project';

/** The fixture Session id. */
const SESSION_ID = 'session-00000000-1111-2222-3333-444444444444';

/** Where the fixture's log directory must be derived to. */
const logDir = plugin.sessionDirOf(CWD, SESSION_ID);
const cacheFile = join(plugin.PROJ_CACHE_ROOT, `${plugin.encodeSegment(SESSION_ID)}.json`);

/**
 * Build the fixture artifacts the delete is expected to move.
 */
function seedArtifacts() {
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, 'session.v4.jsonl.zstd'), 'fixture-log');
  mkdirSync(plugin.PROJ_CACHE_ROOT, { recursive: true });
  writeFileSync(cacheFile, '{"fixture":true}');
}

/** Re-create the fixture artifacts when an earlier case already deleted them. */
function ensureArtifacts() {
  if (!existsSync(logDir) || !existsSync(cacheFile)) seedArtifacts();
}

/** Project directories and quarantine leftovers currently under the sessions root. */
function sessionsRootEntries() {
  return readdirSync(plugin.SESSIONS_ROOT, { withFileTypes: true });
}

/** Quarantine directories a completed delete must never leave behind. */
function quarantineLeftovers() {
  return sessionsRootEntries().filter((entry) => entry.name.startsWith('.dsh-session-delete-')).map((entry) => entry.name);
}

/**
 * Build one composed-context stand-in recording every service interaction.
 * @param options - fixture switches.
 * @param options.running - whether the fake Agent reports a running turn.
 * @param options.live - whether the fake Session store also holds the Session.
 * @param options.stubborn - a running Agent that does not stop when asked.
 * @param options.archived - whether the Session starts in the archive set (default true).
 * @param options.logPath - a backend answer for the Session's log path.
 * @param options.listThrows - make the persistence listing fail.
 * @returns the context, the recorder, and the header.
 */
function makeContext(options = {}) {
  const calls = { detached: [], unarchived: [], unpinned: [], archived: [], emitted: [], warnings: [] };
  const header = { version: 4, id: SESSION_ID, createdAt: Date.now(), cwd: CWD, isSeeded: false };
  let running = options.running === true;
  const workspace = {
    id: 'ws-1',
    path: CWD,
    sessionIds: [SESSION_ID],
    detachSession: async (id) => {
      calls.detached.push(id);
      workspace.sessionIds = workspace.sessionIds.filter((entry) => entry !== id);
    },
  };
  const registry = {
    archivedSessionIds: options.archived === false ? [] : [SESSION_ID],
    pinnedSessionIds: [SESSION_ID],
    list: () => [workspace],
    archiveSession: async (id, archiveOptions) => {
      calls.archived.push({ id, stopActivity: archiveOptions?.stopActivity === true });
      registry.archivedSessionIds = [...registry.archivedSessionIds, id];
      if (archiveOptions?.stopActivity === true && options.stubborn !== true) running = false;
    },
    unarchiveSession: async (id) => {
      calls.unarchived.push(id);
      registry.archivedSessionIds = registry.archivedSessionIds.filter((entry) => entry !== id);
    },
    unpinSession: async (id) => {
      calls.unpinned.push(id);
      registry.pinnedSessionIds = registry.pinnedSessionIds.filter((entry) => entry !== id);
    },
  };
  const persistence = {
    list: options.listThrows === true
      ? async () => { throw new Error('persistence listing unavailable'); }
      : async () => [{ header, revision: 'r1', sizeBytes: 11 }],
    ...(options.logPath === undefined ? {} : { resolveCurrentLog: async () => options.logPath }),
  };
  const ctx = {
    get: (key) => ({
      workspaceRegistry: registry,
      sessionPersistence: persistence,
      sessions: options.live === true ? { get: () => ({ header }) } : { get: () => undefined },
      agents: { get: () => (running ? { status: 'running' } : undefined) },
    })[key],
    emit: (event, id) => calls.emitted.push({ event, id }),
    logger: {
      info: () => {},
      warn: (message) => calls.warnings.push(`warn ${String(message)}`),
      error: (message) => calls.warnings.push(`error ${String(message)}`),
    },
  };
  return { ctx, calls, header, workspace, registry };
}

// ── 1. preview touches nothing ─────────────────────────────────────────────

seedArtifacts();
{
  const { ctx, calls } = makeContext();
  const outcome = await plugin.deleteSession(ctx, { sessionId: SESSION_ID, modifyOnly: true });
  check('preview reports the session directory it would move', outcome.paths[0] === logDir, outcome.paths[0]);
  check('preview reports the projection checkpoint it would move', outcome.paths[1] === cacheFile, outcome.paths[1]);
  check('preview leaves the log directory in place', existsSync(logDir));
  check('preview leaves the projection checkpoint in place', existsSync(cacheFile));
  check('preview does not emit the browser removal', calls.emitted.length === 0);
}

// ── 2. a running Session is stopped, or refused when it will not stop ─────

{
  // Preview never touches a live turn: it only reports that confirming will
  // stop the work.
  const { ctx, calls } = makeContext({ running: true });
  const outcome = await plugin.deleteSession(ctx, { sessionId: SESSION_ID, modifyOnly: true });
  check('a preview of a running Session stops nothing', calls.archived.length === 0);
  check('a preview of a running Session says it will stop the turn',
    outcome.warnings.some((warning) => warning.includes('will stop its turn')),
    JSON.stringify(outcome.warnings));
  check('a preview of a running Session leaves the log directory in place', existsSync(logDir));
}

{
  const { ctx, calls } = makeContext({ running: true, live: true });
  const outcome = await plugin.deleteSession(ctx, { sessionId: SESSION_ID });
  check('a running Session is stopped through the archive admission seam',
    calls.archived.length === 1 && calls.archived[0].stopActivity === true,
    JSON.stringify(calls.archived));
  check('the temporary archive marker is cleared again', calls.unarchived.includes(SESSION_ID));
  check('the stopped Session is then deleted', outcome.modifyOnly === false && !existsSync(logDir));
}

{
  seedArtifacts();
  const { ctx, calls, registry } = makeContext({ running: true, stubborn: true });
  let refusal;
  try {
    await plugin.deleteSession(ctx, { sessionId: SESSION_ID });
  } catch (error) {
    refusal = error;
  }
  check('a Session that will not stop is refused', refusal?.code === 'session-delete/running', String(refusal?.code));
  check('a refused delete leaves the workspace slot alone', calls.detached.length === 0);
  check('a refused delete leaves the log directory in place', existsSync(logDir));
  check('a refused delete reports no files were deleted', String(refusal?.message).includes('no files were deleted'), String(refusal?.message));
  // The Session started archived, and the stop seam must not silently clear
  // that marker: the refusal still names it because it is still there.
  check('a refused delete keeps the archive state it started with',
    registry.archivedSessionIds.includes(SESSION_ID),
    JSON.stringify(registry.archivedSessionIds));
  check('a refused delete names the archive marker it kept', String(refusal?.message).includes('archived'), String(refusal?.message));
}

{
  // The ordinary case: the Session is live but not archived, so the marker was
  // borrowed and has to be given back. The refusal must not send the operator
  // looking for an archived row that does not exist.
  seedArtifacts();
  const { ctx, calls, registry } = makeContext({ running: true, stubborn: true, archived: false });
  let refusal;
  try {
    await plugin.deleteSession(ctx, { sessionId: SESSION_ID });
  } catch (error) {
    refusal = error;
  }
  check('a refused delete leaves an unarchived Session unarchived',
    !registry.archivedSessionIds.includes(SESSION_ID),
    JSON.stringify(registry.archivedSessionIds));
  check('the ordinary refusal does not tell the operator to unarchive anything',
    !String(refusal?.message).includes('unarchive'),
    String(refusal?.message));
  check('the ordinary refusal still reports that no files were deleted',
    String(refusal?.message).includes('no files were deleted'),
    String(refusal?.message));
  check('the ordinary refusal leaves the workspace slot alone', calls.detached.length === 0);
}

// ── 3. the real delete ────────────────────────────────────────────────────

ensureArtifacts();
{
  const { ctx, calls, workspace } = makeContext();
  const outcome = await plugin.deleteSession(ctx, { sessionId: SESSION_ID });
  check('the log directory is gone from the sessions root', !existsSync(logDir));
  check('the projection checkpoint is gone from the cache root', !existsSync(cacheFile));
  check('the outcome reports both paths it removed', outcome.paths[0] === logDir && outcome.paths[1] === cacheFile, JSON.stringify(outcome.paths));
  check('no trash or quarantine directory is left behind', quarantineLeftovers().length === 0, JSON.stringify(quarantineLeftovers()));
  check('the outcome carries no trash location', outcome.trashRoot === undefined);
  check('the Session left the workspace accounting', calls.detached.includes(SESSION_ID) && workspace.sessionIds.length === 0);
  check('the Session left the archive set', calls.unarchived.includes(SESSION_ID));
  check('the Session left the pin set', calls.unpinned.includes(SESSION_ID));
  check('the browser was told to drop the row',
    calls.emitted.length === 1 && calls.emitted[0].event === 'api-session/removed' && calls.emitted[0].id === SESSION_ID,
    JSON.stringify(calls.emitted));
  check('the delete reported no warnings', outcome.warnings.length === 0, JSON.stringify(outcome.warnings));
  check('the outcome is not marked as a preview', outcome.modifyOnly === false);
}

// ── 3b. a symlinked Session directory is refused ──────────────────────────

{
  seedArtifacts();
  const elsewhere = join(home, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, 'keep.txt'), 'must survive');
  // Replace the Session directory with a link pointing outside the root: a
  // recursive remove must never follow it.
  rmSync(logDir, { recursive: true, force: true });
  symlinkSync(elsewhere, logDir, 'junction');
  const { ctx, calls } = makeContext();
  let refusal;
  try {
    await plugin.deleteSession(ctx, { sessionId: SESSION_ID });
  } catch (error) {
    refusal = error;
  }
  check('a symlinked Session directory is refused', refusal?.code === 'session-delete/unsafe-location', String(refusal?.code));
  check('the symlink target survived untouched', existsSync(join(elsewhere, 'keep.txt')));
  check('the refusal happened before any accounting change', calls.detached.length === 0);
  rmSync(logDir, { recursive: true, force: true });
}

// ── 3c. a harness home reached through a link still deletes ───────────────

{
  // Moving a harness home to another volume and leaving a junction (or a
  // symlink) behind is a normal setup. The containment check must compare
  // resolved paths on both sides, or every delete on such a machine is refused
  // as if the Session directory had escaped the sessions root.
  const linkContainer = mkdtempSync(join(tmpdir(), 'dsh-session-delete-link-'));
  const realHome = join(linkContainer, 'real-home');
  const linkedHome = join(linkContainer, 'linked-home');
  mkdirSync(realHome, { recursive: true });
  symlinkSync(realHome, linkedHome, 'junction');
  const previousHome = process.env['DSH_HOME'];
  let linked;
  try {
    process.env['DSH_HOME'] = linkedHome;
    // A fresh module instance: this plugin resolves its roots at import time.
    linked = await import(`${pathToFileURL(join(here, '..', 'src', 'index.js')).href}?linked-home`);
  } finally {
    if (previousHome === undefined) delete process.env['DSH_HOME'];
    else process.env['DSH_HOME'] = previousHome;
  }
  const linkedDir = linked.sessionDirOf(CWD, SESSION_ID);
  const linkedCache = join(linked.PROJ_CACHE_ROOT, `${linked.encodeSegment(SESSION_ID)}.json`);
  mkdirSync(linkedDir, { recursive: true });
  writeFileSync(join(linkedDir, 'session.v4.jsonl.zstd'), 'fixture-log');
  mkdirSync(linked.PROJ_CACHE_ROOT, { recursive: true });
  writeFileSync(linkedCache, '{"fixture":true}');

  const derived = makeContext();
  const outcome = await linked.deleteSession(derived.ctx, { sessionId: SESSION_ID });
  check('a Session under a linked harness home is deleted, not refused as an escape',
    outcome.paths[0] === linkedDir && !existsSync(linkedDir) && !existsSync(linkedCache),
    JSON.stringify(outcome.paths));
  check('the linked-home delete unaccounted the Session', derived.calls.detached.includes(SESSION_ID));

  // A backend that answers with the link already resolved must be accepted for
  // the same reason: it names the same artifact, not an escape.
  mkdirSync(linkedDir, { recursive: true });
  writeFileSync(join(linkedDir, 'session.v4.jsonl.zstd'), 'fixture-log');
  const resolvedLog = join(realpathSync(linkedDir), 'session.v4.jsonl.zstd');
  const viaBackend = makeContext({ logPath: resolvedLog });
  const backendOutcome = await linked.deleteSession(viaBackend.ctx, { sessionId: SESSION_ID });
  check('a backend answer in resolved form still deletes through the linked home',
    backendOutcome.locationSource === 'backend' && !existsSync(linkedDir),
    `${backendOutcome.locationSource} ${JSON.stringify(backendOutcome.paths)}`);
  rmSync(linkContainer, { recursive: true, force: true });
}

// ── 4. unknown and missing artifacts ─────────────────────────────────────

{
  const { ctx } = makeContext();
  const base = ctx.get;
  ctx.get = (key) => (key === 'sessionPersistence' ? { list: async () => [] } : base(key));
  let refusal;
  try {
    await plugin.deleteSession(ctx, { sessionId: 'session-unknown' });
  } catch (error) {
    refusal = error;
  }
  check('an unknown Session is refused as not-found', refusal?.code === 'session-delete/not-found', String(refusal?.code));
}

{
  // Second delete of the same id: the artifacts are already gone, so the
  // operation must still succeed idempotently.
  const { ctx } = makeContext();
  const outcome = await plugin.deleteSession(ctx, { sessionId: SESSION_ID });
  check('deleting again is idempotent for missing artifacts', outcome.paths.length === 2 && !existsSync(logDir));
}

// ── 4b. the backend's log answer drives the target, or is refused ─────────

{
  seedArtifacts();
  const { ctx } = makeContext({ logPath: join(logDir, 'session.v4.jsonl.zstd') });
  const outcome = await plugin.deleteSession(ctx, { sessionId: SESSION_ID });
  check('a backend answer inside the sessions root is used for the directory',
    outcome.locationSource === 'backend' && outcome.paths[0] === logDir,
    `${outcome.locationSource} ${JSON.stringify(outcome.paths)}`);
  check('the backend-answered directory is removed', !existsSync(logDir) && !existsSync(cacheFile));
}

{
  seedArtifacts();
  // Exactly three relative segments outside the root, so only the containment
  // comparison — not the shape check — can refuse this answer.
  const escapeDir = join(home, 'backend-escape');
  const escapeLog = join(escapeDir, 'session.v4.jsonl.zstd');
  mkdirSync(escapeDir, { recursive: true });
  writeFileSync(escapeLog, 'must survive');
  const { ctx, calls } = makeContext({ logPath: escapeLog });
  let refusal;
  try {
    await plugin.deleteSession(ctx, { sessionId: SESSION_ID });
  } catch (error) {
    refusal = error;
  }
  check('a backend answer outside the sessions root is refused',
    refusal?.code === 'session-delete/unsafe-location',
    String(refusal?.code));
  check('the outside answer is refused before any accounting change', calls.detached.length === 0);
  check('the tree the backend named survives untouched', existsSync(escapeLog));
  check('the Session artifacts survive the refusal', existsSync(logDir) && existsSync(cacheFile));
}

// ── 4c. a directory swapped mid-delete is put back ───────────────────────

{
  seedArtifacts();
  const { ctx, calls, workspace } = makeContext();
  const detach = workspace.detachSession;
  workspace.detachSession = async (id) => {
    await detach(id);
    // Replace the directory in the window between the identity capture and the
    // quarantine move: the re-check must refuse and put the replacement back.
    rmSync(logDir, { recursive: true, force: true });
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'replacement.txt'), 'must survive');
  };
  let refusal;
  try {
    await plugin.deleteSession(ctx, { sessionId: SESSION_ID });
  } catch (error) {
    refusal = error;
  }
  check('a directory swapped mid-delete is refused as unsafe-location',
    refusal?.code === 'session-delete/unsafe-location',
    String(refusal?.code));
  check('the swapped directory is put back in place', existsSync(join(logDir, 'replacement.txt')));
  check('the swap refusal removed no artifact', existsSync(cacheFile));
  check('the swap left no quarantine behind',
    quarantineLeftovers().length === 0,
    JSON.stringify(quarantineLeftovers()));
  check('the browser was told nothing about the refused swap', calls.emitted.length === 0);
}

// ── 4d. an unreadable persistence listing falls back to the registry ──────

{
  seedArtifacts();
  const { ctx } = makeContext({ listThrows: true });
  const outcome = await plugin.deleteSession(ctx, { sessionId: SESSION_ID });
  check('a failing persistence listing falls back to the registry index',
    outcome.cwd === CWD && !existsSync(logDir),
    `${String(outcome.cwd)} ${JSON.stringify(outcome.paths)}`);
  check('the fallback records why persistence was skipped',
    outcome.warnings.some((warning) => warning.includes('persistence')),
    JSON.stringify(outcome.warnings));
}

// ── 4e. a malformed id is a bad request even from a direct caller ─────────

{
  const { ctx } = makeContext();
  let refusal;
  try {
    await plugin.deleteSession(ctx, { sessionId: '../etc/passwd' });
  } catch (error) {
    refusal = error;
  }
  check('a malformed id is refused as a bad request, not an internal error',
    refusal?.code === 'session-delete/bad-request' && refusal?.status === 400,
    `${String(refusal?.code)} HTTP ${String(refusal?.status)}`);
}

// ── 5. the HTTP envelope ─────────────────────────────────────────────────

ensureArtifacts();

/**
 * Build one Fetch-shaped request the route can read.
 * @param options - the request shape.
 * @param options.body - the raw body text.
 * @param options.origin - the Origin header, or null to omit it.
 * @param options.host - the Host header the Origin must match.
 * @param options.confirmation - the confirmation header value, when sent.
 * @param options.contentType - the Content-Type header value.
 * @param options.method - the Http method.
 * @returns a minimal request stand-in.
 */
function requestOf(options = {}) {
  const headers = new Map();
  if (options.contentType !== undefined) headers.set('content-type', options.contentType);
  if (options.origin !== undefined && options.origin !== null) {
    headers.set('origin', options.origin);
    headers.set('host', options.host ?? new URL(options.origin).host);
  }
  if (options.confirmation !== undefined) headers.set('x-dsh-session-delete-confirmation', options.confirmation);
  const text = options.body ?? '';
  return {
    method: options.method ?? 'POST',
    headers: { get: (name) => headers.get(name) ?? null },
    text: async () => text,
  };
}

/** The Origin a same-origin browser fetch carries. */
const BROWSER_ORIGIN = 'http://127.0.0.1:19387';

{
  const response = await plugin.sessionDeleteResponse(makeContext().ctx, requestOf({
    body: JSON.stringify({ sessionId: SESSION_ID, modifyOnly: true }),
    contentType: 'application/json; charset=utf-8',
    origin: BROWSER_ORIGIN,
    confirmation: 'delete-session',
  }));
  const payload = await response.json();
  check('the route answers a confirmed browser preview with 200', response.status === 200 && payload.ok === true, `HTTP ${String(response.status)}`);

  const unconfirmed = await plugin.sessionDeleteResponse(makeContext().ctx, requestOf({
    body: JSON.stringify({ sessionId: SESSION_ID, modifyOnly: true }),
    contentType: 'application/json',
    origin: BROWSER_ORIGIN,
  }));
  check('a browser request without the confirmation header is refused with 403', unconfirmed.status === 403, `HTTP ${String(unconfirmed.status)}`);

  const crossSite = await plugin.sessionDeleteResponse(makeContext().ctx, requestOf({
    body: JSON.stringify({ sessionId: SESSION_ID, modifyOnly: true }),
    contentType: 'application/json',
    origin: 'https://evil.example',
    host: '127.0.0.1:19387',
    confirmation: 'delete-session',
  }));
  check('a cross-site Origin is refused with 403', crossSite.status === 403, `HTTP ${String(crossSite.status)}`);

  // A Web instance served over https through a proxy is still same-origin: the
  // Origin names the host the request was sent to, and the Host's own fence has
  // the final say on which authorities exist.
  const secureSameOrigin = await plugin.sessionDeleteResponse(makeContext().ctx, requestOf({
    body: JSON.stringify({ sessionId: SESSION_ID, modifyOnly: true }),
    contentType: 'application/json',
    origin: 'https://127.0.0.1:19387',
    host: '127.0.0.1:19387',
    confirmation: 'delete-session',
  }));
  check('a same-origin https browser request is admitted', secureSameOrigin.status === 200, `HTTP ${String(secureSameOrigin.status)}`);

  const opaqueOrigin = await plugin.sessionDeleteResponse(makeContext().ctx, requestOf({
    body: JSON.stringify({ sessionId: SESSION_ID, modifyOnly: true }),
    contentType: 'application/json',
    origin: 'null',
    host: '127.0.0.1:19387',
    confirmation: 'delete-session',
  }));
  check('an opaque Origin is refused with 403', opaqueOrigin.status === 403, `HTTP ${String(opaqueOrigin.status)}`);

  const pathOrigin = await plugin.sessionDeleteResponse(makeContext().ctx, requestOf({
    body: JSON.stringify({ sessionId: SESSION_ID, modifyOnly: true }),
    contentType: 'application/json',
    origin: 'https://127.0.0.1:19387/steal',
    host: '127.0.0.1:19387',
    confirmation: 'delete-session',
  }));
  check('an Origin carrying anything but an origin is refused with 403', pathOrigin.status === 403, `HTTP ${String(pathOrigin.status)}`);

  const wrongType = await plugin.sessionDeleteResponse(makeContext().ctx, requestOf({
    body: JSON.stringify({ sessionId: SESSION_ID }),
    contentType: 'text/plain',
    origin: BROWSER_ORIGIN,
    confirmation: 'delete-session',
  }));
  check('a non-JSON body is refused with 415', wrongType.status === 415, `HTTP ${String(wrongType.status)}`);

  const oversized = await plugin.sessionDeleteResponse(makeContext().ctx, requestOf({
    body: 'x'.repeat(9000),
    contentType: 'application/json',
    origin: BROWSER_ORIGIN,
    confirmation: 'delete-session',
  }));
  check('an oversized body is refused with 413', oversized.status === 413, `HTTP ${String(oversized.status)}`);

  // A native caller with no Origin (a CLI or an agent posting to loopback) is
  // admitted by the fence and needs no browser-only header.
  const native = await plugin.sessionDeleteResponse(makeContext().ctx, requestOf({
    body: JSON.stringify({ sessionId: SESSION_ID, modifyOnly: true }),
    contentType: 'application/json',
  }));
  check('an origin-less native caller is admitted', native.status === 200, `HTTP ${String(native.status)}`);

  const badBody = await plugin.sessionDeleteResponse(makeContext().ctx, requestOf({
    body: '{}',
    contentType: 'application/json',
    origin: BROWSER_ORIGIN,
    confirmation: 'delete-session',
  }));
  check('the route rejects a missing sessionId with 400', badBody.status === 400, `HTTP ${String(badBody.status)}`);

  const traversal = await plugin.sessionDeleteResponse(makeContext().ctx, requestOf({
    body: JSON.stringify({ sessionId: '../../etc/passwd' }),
    contentType: 'application/json',
    origin: BROWSER_ORIGIN,
    confirmation: 'delete-session',
  }));
  check('the route rejects a non-id-shaped sessionId with 400', traversal.status === 400, `HTTP ${String(traversal.status)}`);

  const wrongMethod = await plugin.sessionDeleteResponse(makeContext().ctx, requestOf({
    method: 'GET',
    contentType: 'application/json',
    origin: BROWSER_ORIGIN,
    confirmation: 'delete-session',
  }));
  check('the route rejects a non-POST with 405', wrongMethod.status === 405, `HTTP ${String(wrongMethod.status)}`);

  const running = await plugin.sessionDeleteResponse(makeContext({ running: true, stubborn: true }).ctx, requestOf({
    body: JSON.stringify({ sessionId: SESSION_ID }),
    contentType: 'application/json',
    origin: BROWSER_ORIGIN,
    confirmation: 'delete-session',
  }));
  const runningBody = await running.json();
  check('the route maps a live refusal to 409',
    running.status === 409 && runningBody.error.code === 'session-delete/running',
    `HTTP ${String(running.status)} ${String(runningBody.error?.code)}`);
}

// ── 6. the plugin face: apply() must never throw ──────────────────────────

/**
 * A host context that behaves like a hostile Cordis scope: reading an
 * undeclared property throws, `get` answers only the named services, and the
 * logger records instead of printing.
 * @param options - what the fake composition provides.
 * @param options.connection - the Connection service value, or undefined.
 * @param options.getThrows - make `ctx.get` itself throw.
 * @returns the context and the recorded log lines.
 */
function makeApplyContext(options = {}) {
  const log = [];
  const target = {
    ...(options.getThrows === true
      ? { get: () => { throw new Error('service access denied'); } }
      : { get: (key) => (key === 'connection' ? options.connection : undefined) }),
    logger: {
      info: () => {},
      warn: (message) => log.push(`warn ${String(message)}`),
      error: (message) => log.push(`error ${String(message)}`),
    },
  };
  const ctx = new Proxy(target, {
    get(object, property) {
      if (!(property in object)) throw new Error(`cannot read undeclared context member ${String(property)}`);
      return Reflect.get(object, property);
    },
  });
  return { ctx, log };
}

{
  const registered = [];
  const { ctx, log } = makeApplyContext({
    connection: { fetch: { register: (route) => { registered.push(route); return () => {}; } } },
  });
  plugin.apply(ctx);
  check('apply registers exactly one POST route',
    registered.length === 1 && registered[0].path === plugin.SESSION_DELETE_PATH && registered[0].methods.join() === 'POST',
    JSON.stringify(registered.map((route) => route.path)));
  check('apply leaves nothing logged when it succeeds', log.length === 0, JSON.stringify(log));
}

{
  // A composition without the Connection seam must degrade, not fail: a throw
  // inside the plugin fiber fails the whole Web boot and the operator has to
  // disable third-party plugins to start Harness again.
  const { ctx, log } = makeApplyContext({});
  let threw;
  try {
    plugin.apply(ctx);
  } catch (error) {
    threw = error;
  }
  check('apply survives a missing Connection service', threw === undefined, String(threw?.message));
  check('apply reports the missing seam', log.some((line) => line.startsWith('warn')), JSON.stringify(log));
}

{
  const { ctx, log } = makeApplyContext({ getThrows: true });
  let threw;
  try {
    plugin.apply(ctx);
  } catch (error) {
    threw = error;
  }
  check('apply survives a service read that throws', threw === undefined, String(threw?.message));
  check('apply reports the failed read', log.some((line) => line.startsWith('error')), JSON.stringify(log));
}

{
  const { ctx, log } = makeApplyContext({
    connection: { fetch: { register: () => { throw new Error('route path already registered'); } } },
  });
  let threw;
  try {
    plugin.apply(ctx);
  } catch (error) {
    threw = error;
  }
  check('apply survives a rejected route registration', threw === undefined, String(threw?.message));
  check('apply reports the rejected registration',
    log.some((line) => line.includes('route is not registered')),
    JSON.stringify(log));
}

rmSync(home, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
console.log('');
console.log(failed.length === 0 ? `all ${String(checks.length)} checks passed` : `${String(failed.length)} of ${String(checks.length)} check(s) failed`);
process.exitCode = failed.length === 0 ? 0 : 1;
