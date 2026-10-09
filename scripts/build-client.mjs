/**
 * Assemble the DSH client bundle from the authored browser half.
 *
 * DSH serves exactly one file per plugin — `exports["./client"]` — and that file
 * must register itself as a lazy-CJS factory by calling
 * `window.__ModuleLoader__.load({ id, factory })`. The factory form is what
 * makes the plugin's module body execute only when the plugin is first
 * materialized, and it is also why a bundle cannot import a sibling file: the
 * module table has no relative loader.
 *
 * So the loader boilerplate lives HERE, not in the source. `src/client.js` is
 * the authored half: a factory body that uses the three names the loader will
 * bind (`require`, `exports`, `module`). This script wraps it verbatim, which
 * keeps the source reviewable and the generated file reproducible.
 *
 * Usage:
 *   node scripts/build-client.mjs            # write lib/client.js
 *   node scripts/build-client.mjs --check    # fail when lib/client.js is stale
 *
 * @module dsh-session-delete/scripts/build-client
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const sourcePath = join(root, 'src', 'client.js');
const manifestPath = join(root, 'package.json');
const outputPath = join(root, 'lib', 'client.js');

/**
 * The loader's registration id, read from the manifest rather than duplicated:
 * DSH rejects a bundle whose declared id is not the package name the Loader
 * mounted, so the two must never drift.
 */
const PLUGIN_ID = JSON.parse(readFileSync(manifestPath, 'utf8')).name;

/**
 * Build the served bundle text for one authored factory body.
 *
 * Newlines are normalized to LF before anything else: the generated file is
 * compared byte-for-byte by `--check`, so a CRLF working tree would produce a
 * different bundle than CI and fail the check for no real reason.
 * @param body - the `src/client.js` source, as a factory body.
 * @returns the complete `lib/client.js` text.
 */
function buildBundle(body) {
  const indented = body
    .replace(/\r\n?/gu, '\n')
    .replace(/\s+$/u, '')
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `    ${line}`))
    .join('\n');
  return `/**
 * GENERATED FILE — do not edit.
 *
 * Assembled from ../src/client.js by ../scripts/build-client.mjs, which owns the
 * lazy-CJS loader boilerplate below. Edit the source and re-run the script.
 */
window.__ModuleLoader__.load({
  id: '${PLUGIN_ID}',
  factory: (require, module) => {
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

${indented}
  },
});
`;
}

const source = readFileSync(sourcePath, 'utf8');
const bundle = buildBundle(source);

/**
 * Check that the bundle patch mounts the package under its own name.
 *
 * A Loader row whose `name` is not the package name fails silently in the UI:
 * the bundle never mounts, the `dsh.client` declaration is never scanned, and
 * the only evidence is one line on the host's stderr. That is exactly how a
 * rename leaves a healthy-looking profile with no menu entry, so it is checked
 * here rather than discovered by a user.
 * @throws {Error} when a patch row names something other than this package.
 */
function assertBundlePatchNames() {
  const patchPath = join(root, 'cordis.patch.yml');
  const problems = [];
  for (const [index, line] of readFileSync(patchPath, 'utf8').split('\n').entries()) {
    const match = /^\s*-?\s*name:\s*(?<name>.*?)\s*$/u.exec(line);
    if (match === null) continue;
    const rowName = match.groups.name.replace(/^['"]|['"]$/gu, '');
    if (rowName === '') continue;
    // A row may name this package, or a cordis builtin/file address.
    if (rowName === PLUGIN_ID || rowName.startsWith('cordis:') || rowName.startsWith('.')) continue;
    problems.push(`${patchPath}:${String(index + 1)} mounts ${JSON.stringify(rowName)} but this package is ${JSON.stringify(PLUGIN_ID)}`);
  }
  if (problems.length > 0) throw new Error(`bundle patch name mismatch:\n  ${problems.join('\n  ')}`);
}

assertBundlePatchNames();

if (process.argv.includes('--check')) {
  let current;
  try {
    current = readFileSync(outputPath, 'utf8');
  } catch {
    console.error(`build-client: ${outputPath} is missing; run the build`);
    process.exitCode = 1;
    process.exit();
  }
  if (current !== bundle) {
    console.error('build-client: lib/client.js is stale; run node scripts/build-client.mjs');
    process.exitCode = 1;
  } else {
    console.log('build-client: lib/client.js is up to date');
  }
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, bundle);
  console.log(`build-client: wrote ${outputPath} (${String(Buffer.byteLength(bundle))} bytes)`);
}
