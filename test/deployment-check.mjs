/**
 * Checks for the deployment smoke script itself.
 *
 * `test/verify-endpoint.mjs` is the only tool an operator can point at a
 * running harness, so its exit status has to agree with its own guidance:
 *
 * 1. a 404 carrying the plugin's refusal envelope proves the probe reached the
 *    mounted route (the trust fence answers 401/403 instead), so it must not be
 *    reported as a failure;
 * 2. a named base URL that does not answer must be reported as that URL, not as
 *    a sweep of candidate ports the run never performed.
 *
 * Both are pinned by running the script as a child process against a stub host
 * on loopback and against a port nothing listens on.
 *
 * Usage:
 *   node test/deployment-check.mjs
 *
 * @module dsh-session-delete/test/deployment-check
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

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

// The harness home is redirected before the plugin resolves its roots, exactly
// as the smoke script expects to find them.
const home = mkdtempSync(join(tmpdir(), 'dsh-session-delete-verify-'));
process.env['DSH_HOME'] = home;
const plugin = await import(pathToFileURL(join(repoRoot, 'src', 'index.js')).href);

/** The Session id the smoke check is asked to derive a directory for. */
const SESSION_ID = 'session-00000000-1111-2222-3333-444444444444';

// The roots and the sampled Session directory have to exist, and the derivation
// has to match the smoke script's own project key for this checkout. Both sides
// build it from `join(here, '..')`, so the literal path is identical.
mkdirSync(plugin.SESSIONS_ROOT, { recursive: true });
mkdirSync(plugin.PROJ_CACHE_ROOT, { recursive: true });
mkdirSync(plugin.sessionDirOf(repoRoot, SESSION_ID), { recursive: true });

/**
 * Run the smoke script against one base URL.
 * @param args - the script arguments.
 * @returns the exit code and the combined output.
 */
function runVerify(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(repoRoot, 'test', 'verify-endpoint.mjs'), ...args], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: home },
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ code, output }));
  });
}

/** A stub host whose route answer is the plugin's own unknown-session refusal. */
const server = createServer((request, response) => {
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: false, error: { code: 'session-delete/not-found', message: 'no such session' } }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

const mounted = await runVerify([SESSION_ID, `http://127.0.0.1:${String(port)}`]);
check('a probe that reached the mounted route passes the smoke check',
  mounted.code === 0 && mounted.output.includes('the request was answered by the trust fence'),
  `exit ${String(mounted.code)}`);

/** A port on which nothing listens: reserved, then released, then probed. */
const closedPort = await new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port: reserved } = probe.address();
    probe.close(() => resolve(reserved));
  });
});

const unreachable = await runVerify([SESSION_ID, `http://127.0.0.1:${String(closedPort)}`]);
check('a named base URL that does not answer is reported as the given URL',
  unreachable.code === 1
    && unreachable.output.includes('the given base URL')
    && !unreachable.output.includes('tried 19387'),
  `exit ${String(unreachable.code)}`);

server.close();
rmSync(home, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
console.log('');
console.log(failed.length === 0 ? `all ${String(checks.length)} checks passed` : `${String(failed.length)} of ${String(checks.length)} check(s) failed`);
process.exitCode = failed.length === 0 ? 0 : 1;
