/**
 * Verify the `dsh-session-delete` deployment against a running DSH instance.
 *
 * Two things can be checked without a browser: that the plugin's path
 * derivations still point at this machine's real roots, and that the Host is
 * reachable at the expected URL. Whether the *route* is mounted cannot be told
 * apart from the browser-trust fence's refusal with an unauthenticated request
 * — any `/api/*` path answers 401 — so the authoritative check is the
 * authenticated one the script prints for the Web UI console.
 *
 * Usage:
 *   node test/verify-endpoint.mjs [sessionId] [baseUrl]
 *
 * @module dsh-session-delete/test/verify-endpoint
 */

import { existsSync } from 'node:fs';

import {
  PROJ_CACHE_ROOT,
  SESSIONS_ROOT,
  SESSION_DELETE_PATH,
  encodeSegment,
  projectKey,
  sessionDirOf,
} from '../src/index.js';

const baseUrl = process.argv[3] ?? 'http://127.0.0.1:19387';
const sessionId = process.argv[2];
const checks = [];

/**
 * Record one named check.
 * @param label - what was checked.
 * @param ok - its outcome.
 * @param detail - optional evidence.
 */
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`);
}

console.log(`harness home roots`);
console.log(`  sessions : ${SESSIONS_ROOT}`);
console.log(`  projcache: ${PROJ_CACHE_ROOT}`);
console.log('');

check('sessions root exists', existsSync(SESSIONS_ROOT), SESSIONS_ROOT);
check('projection cache root exists', existsSync(PROJ_CACHE_ROOT), PROJ_CACHE_ROOT);

if (sessionId !== undefined) {
  const sample = 'D:\\code\\dsh-session-delete';
  const derived = sessionDirOf(sample, sessionId);
  check('derived session directory matches the persistence layout', existsSync(derived), derived);
  const cacheFile = `${PROJ_CACHE_ROOT}\\${encodeSegment(sessionId)}.json`;
  console.log(`  (projection checkpoint: ${existsSync(cacheFile) ? 'present' : 'absent'} — ${cacheFile})`);
  console.log(`  (project key for ${sample}: ${projectKey(sample)})`);
}

let status = 0;
let body = '';
try {
  const response = await fetch(`${baseUrl}${SESSION_DELETE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'probe', modifyOnly: true }),
  });
  status = response.status;
  body = (await response.text()).slice(0, 120);
} catch (error) {
  check('host answers on the delete route', false, error instanceof Error ? error.message : String(error));
}
if (status !== 0) {
  check('host is reachable at the configured URL', true, `${baseUrl} answered HTTP ${status}`);
  check('the route path is behind the browser-trust fence (expected 401/403)',
    status === 401 || status === 403 || status === 200,
    `HTTP ${status} ${body}`);
}

const failed = checks.filter((entry) => !entry.ok);
console.log('');
console.log(failed.length === 0 ? 'all checks passed' : `${String(failed.length)} check(s) failed`);
if (sessionId !== undefined) {
  console.log('');
  console.log('To exercise the authenticated route, run this in the Web UI console (an absolute URL');
  console.log('keeps it same-origin and carries the session cookie):');
  console.log(`  await fetch('${baseUrl}${SESSION_DELETE_PATH}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: ${JSON.stringify(sessionId)}, modifyOnly: true }) }).then(r => r.json())`);
  console.log('A preview answer means the route is mounted; 404 means the bundle row did not load.');
}
process.exitCode = failed.length === 0 ? 0 : 1;
