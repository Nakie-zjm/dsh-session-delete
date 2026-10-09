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

import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
 * @param options.logPath - a backend answer for the Session's log path.
 * @param options.symlinkDir - make the derived Session directory a symlink.
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
    archivedSessionIds: [SESSION_ID],
    pinnedSessionIds: [SESSION_ID],
    enqueueOperation: async (operation) => operation(),
    setState: async (state) => {
      registry.archivedSessionIds = state.archivedSessionIds;
      registry.pinnedSessionIds = state.pinnedSessionIds;
    },
    requireState: () => ({
      initialized: true,
      workspaceIds: ['ws-1'],
      archivedSessionIds: registry.archivedSessionIds,
      pinnedSessionIds: registry.pinnedSessionIds,
    }),
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
    list: async () => [{ header, revision: 'r1', sizeBytes: 11 }],
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
  const { ctx, calls } = makeContext({ running: true, stubborn: true });
  let refusal;
  try {
    await plugin.deleteSession(ctx, { sessionId: SESSION_ID });
  } catch (error) {
    refusal = error;
  }
  check('a Session that will not stop is refused', refusal?.code === 'session-delete/running', String(refusal?.code));
  check('a refused delete leaves the workspace slot alone', calls.detached.length === 0);
  check('a refused delete leaves the log directory in place', existsSync(logDir));
  // The stop itself borrows the archive marker, so this refusal reports that
  // state instead of claiming the session is untouched.
  check('a refused delete reports no files were deleted', String(refusal?.message).includes('no files were deleted'), String(refusal?.message));
  check('a refused delete names the borrowed archive marker', String(refusal?.message).includes('archived'), String(refusal?.message));
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

  const spoofedHost = await plugin.sessionDeleteResponse(makeContext().ctx, requestOf({
    body: JSON.stringify({ sessionId: SESSION_ID, modifyOnly: true }),
    contentType: 'application/json',
    origin: 'https://evil.example',
    confirmation: 'delete-session',
  }));
  check('an Origin matching only its own Host header is refused with 403', spoofedHost.status === 403, `HTTP ${String(spoofedHost.status)}`);

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

rmSync(home, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
console.log('');
console.log(failed.length === 0 ? `all ${String(checks.length)} checks passed` : `${String(failed.length)} of ${String(checks.length)} check(s) failed`);
process.exitCode = failed.length === 0 ? 0 : 1;
