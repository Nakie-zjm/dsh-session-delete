/**
 * Deployment smoke check for `dsh-session-delete`.
 *
 * It answers two questions an unauthenticated script legitimately can:
 *
 * 1. Does this machine's harness home resolve to roots that exist, and does the
 *    persistence layout derivation point at a real session directory?
 * 2. Is a DSH host running, and on which port?
 *
 * What it CANNOT answer is whether the delete route is mounted: the browser
 * trust fence refuses any `/api/*` request it did not authenticate, so a
 * mounted route and an absent one both answer 401 to this script. The
 * authoritative check is the authenticated call it prints for the Web UI
 * console — run that there.
 *
 * Nothing here is machine-specific: the home comes from `DSH_HOME` (or `~/.dsh`)
 * through the plugin's own resolver, and the base URL is given, discovered, or
 * fallen back to the desktop default.
 *
 * Usage:
 *   node test/verify-endpoint.mjs [sessionId] [baseUrl]
 *
 * Environment:
 *   DSH_HOME     harness home to resolve roots against (default `~/.dsh`)
 *   DSH_WEB_URL  base URL to use, e.g. http://127.0.0.1:19387
 *
 * @module dsh-session-delete/test/verify-endpoint
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROJ_CACHE_ROOT,
  SESSIONS_ROOT,
  SESSION_DELETE_PATH,
  SESSION_ID_PATTERN,
  encodeSegment,
  projectKey,
  sessionDirOf,
} from '../src/index.js';

/** The desktop application's fixed port, tried after anything the caller named. */
const DESKTOP_PORT = 19387;

/** Ports probed when no base URL was given, in the order a DSH host is likely bound. */
const CANDIDATE_PORTS = [DESKTOP_PORT, 3000, 8080, 8000, 5173];

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const baseUrlArgument = process.argv[3];
const sessionIdArgument = process.argv[2];
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

/**
 * Probe one candidate origin for a DSH host.
 * @param origin - base URL to probe, without a trailing slash.
 * @returns the observed answer, or `undefined` when nothing answered.
 */
async function probe(origin) {
  try {
    const response = await fetch(`${origin}${SESSION_DELETE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'probe', modifyOnly: true }),
      signal: AbortSignal.timeout(3000),
    });
    return { status: response.status, body: (await response.text()).slice(0, 120) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Resolve the base URL to check: the caller's argument, then `DSH_WEB_URL`,
 * then a probe of the ports a DSH host is likely bound to.
 * @returns the base URL, or undefined when no host answered.
 */
async function resolveBaseUrl() {
  const named = baseUrlArgument ?? process.env['DSH_WEB_URL'];
  if (named !== undefined && named !== '') {
    const origin = named.replace(/\/+$/u, '');
    const answer = await probe(origin);
    if (answer?.error !== undefined) {
      check('the named base URL answers', false, `${origin}: ${answer.error}`);
      return undefined;
    }
    console.log(`host: ${origin} (given)`);
    return origin;
  }
  for (const port of CANDIDATE_PORTS) {
    const origin = `http://127.0.0.1:${String(port)}`;
    const answer = await probe(origin);
    if (answer?.error === undefined) {
      console.log(`host: ${origin} (discovered)`);
      return origin;
    }
  }
  return undefined;
}

console.log('harness home roots');
console.log(`  home     : ${process.env['DSH_HOME'] ?? '(default ~/.dsh)'}`);
console.log(`  sessions : ${SESSIONS_ROOT}`);
console.log(`  projcache: ${PROJ_CACHE_ROOT}`);
console.log('');

check('sessions root exists', existsSync(SESSIONS_ROOT), SESSIONS_ROOT);
check('projection cache root exists', existsSync(PROJ_CACHE_ROOT), PROJ_CACHE_ROOT);
check('the checked-out package has a built client bundle', existsSync(join(repoRoot, 'lib', 'client.js')), join(repoRoot, 'lib', 'client.js'));

if (sessionIdArgument !== undefined) {
  if (!SESSION_ID_PATTERN.test(sessionIdArgument)) {
    check('the supplied session id has the shape persistence mints', false, sessionIdArgument);
  } else {
    // The sample project must be a real one on this machine, so it is taken from
    // the repository's own location rather than hard-coded.
    const derived = sessionDirOf(repoRoot, sessionIdArgument);
    check('the persistence layout derivation points at an existing directory', existsSync(derived), derived);
    const cacheFile = join(PROJ_CACHE_ROOT, `${encodeSegment(sessionIdArgument)}.json`);
    console.log(`  (projection checkpoint: ${existsSync(cacheFile) ? 'present' : 'absent'} — ${cacheFile})`);
    console.log(`  (project key for ${repoRoot}: ${projectKey(repoRoot)})`);
  }
}

const baseUrl = await resolveBaseUrl();
if (baseUrl === undefined) {
  check('a DSH host answers on a probed port', false, `tried ${CANDIDATE_PORTS.join(', ')}; pass a base URL or set DSH_WEB_URL`);
} else {
  const answer = await probe(baseUrl);
  check('the host answers HTTP', answer?.error === undefined, answer?.error ?? `HTTP ${String(answer?.status)} ${answer?.body ?? ''}`);
  check('the request reached the trust fence (401/403) or the route itself (200)',
    [200, 401, 403].includes(answer?.status),
    `HTTP ${String(answer?.status)} ${answer?.body ?? ''}`);
  console.log('');
  console.log('To check the authenticated route, run this in the Web UI console:');
  console.log(`  await fetch('${SESSION_DELETE_PATH}', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-session-delete-confirmation': 'delete-session' }, body: JSON.stringify({ sessionId: ${JSON.stringify(sessionIdArgument ?? '<a-session-id>')}, modifyOnly: true }) }).then(r => r.status + ' ' + r.statusText)`);
  console.log('400 (bad session id shape) or 404 (unknown session) both mean the route is mounted.');
}

const failed = checks.filter((entry) => !entry.ok);
console.log('');
console.log(failed.length === 0 ? 'all checks passed' : `${String(failed.length)} of ${String(checks.length)} check(s) failed`);
process.exitCode = failed.length === 0 ? 0 : 1;
