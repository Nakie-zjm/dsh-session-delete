/**
 * Browser-half checks that need no browser.
 *
 * The SERVED bundle is generated lazy CJS (`lib/client.js`), so it can be
 * materialized in Node against stubs for its four external requests. React
 * itself is not run: the React surface is asserted structurally (every exported
 * component is a function, the modal gates on the pending request, the menu row
 * reads the open-state tuple), while the parts that actually carry state — the
 * delete controller, the derived Set, the Host fetch contract — are exercised
 * for real against a mocked `fetch`.
 *
 * Usage:
 *   node test/browser-half.mjs
 *
 * @module dsh-session-delete/test/browser-half
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const bundlePath = join(root, 'lib', 'client.js');

/** The package name the loader must see as the bundle id; read, never duplicated. */
const PACKAGE_NAME = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;

/**
 * The `@deepseek-ai/dsh-client-store` surface this bundle consumes. The real
 * package pulls zustand and immer, which the packaged app keeps inside its own
 * bundle, so the observable contract is reproduced instead: a snapshot source
 * whose identity changes only when the owner writes.
 * @param initial - the initial snapshot.
 * @returns the snapshot store.
 */
function createSnapshotStore(initial) {
  let snapshot = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (next) => {
      snapshot = typeof next === 'function' ? next(snapshot) : next;
      for (const listener of listeners) listener();
    },
  };
}

const clientStore = { createSnapshotStore };

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

// ── module stubs ───────────────────────────────────────────────────────────

/** Minimal React stand-in: the hooks this bundle calls, without a renderer. */
const react = {
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial }),
  useId: () => 'test-id',
};

/** JSX runtime stand-in: components are called as plain functions by this test. */
const jsxRuntime = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
  Fragment: Symbol('Fragment'),
};

/** UI primitive stand-in: every component returns its own props for assertions. */
const primitive = (name) => {
  const component = (props) => ({ primitive: name, props });
  component.displayName = name;
  return component;
};
const primitives = {
  Button: primitive('Button'),
  MenuItemButton: primitive('MenuItemButton'),
  Modal: primitive('Modal'),
  Toast: primitive('Toast'),
  IconTrashOutlineRegular: primitive('IconTrashOutlineRegular'),
};

const modules = {
  react,
  'react/jsx-runtime': jsxRuntime,
  '@deepseek-ai/dsh-client-store': clientStore,
  '@deepseek-ai/dsh-client-ui-primitives': primitives,
};

globalThis.window = {
  __ModuleLoader__: {
    load: (registration) => {
      loaded = registration;
    },
  },
};

let loaded;
const bundleSource = readFileSync(bundlePath, 'utf8');
new Function('window', bundleSource)(globalThis.window);
check('bundle registers itself under the package id', loaded?.id === PACKAGE_NAME, loaded?.id);
check('the served bundle is the generated file', bundleSource.includes('GENERATED FILE'), bundlePath);
check('the served bundle uses LF endings only',
  !bundleSource.includes('\r'),
  `${String((bundleSource.match(/\r/gu) ?? []).length)} CR bytes`);
check('the authored source uses LF endings only',
  !readFileSync(join(root, 'src', 'client.js'), 'utf8').includes('\r'));

/**
 * Materialize the registered factory the way the loader does: one fresh module
 * object per plugin, resolved externals, execution only on this call.
 * @returns the plugin's exports.
 */
function materialize() {
  const module = { exports: {} };
  const value = loaded.factory((specifier) => {
    if (!(specifier in modules)) throw new Error(`client bundle requested unknown module ${specifier}`);
    return modules[specifier];
  }, module);
  return value ?? module.exports;
}

const exports = materialize();
check('bundle exports apply()', typeof exports.apply === 'function');
check('bundle exports the plugin name', exports.name === 'session-delete', String(exports.name));

// ── mount against a fake browser context ───────────────────────────────────

const registrations = [];
const dictionaries = [];
const cleanups = [];
const provided = new Map();
const ctx = {
  provide: (key, value) => provided.set(key, value),
  effect: (factory) => {
    cleanups.push(factory());
  },
  locale: { register: (ns, dicts) => dictionaries.push({ ns, dicts }) },
  slots: {
    inject: (hole, factory) => {
      const dispose = factory();
      registrations.push({ hole, dispose });
    },
    register: (declaration, component) => {
      registrations.push({ hole: declaration.name, declaration, component });
      return () => {};
    },
  },
};

exports.apply(ctx);
check('registers a browser dictionary for its namespace', dictionaries.some((entry) => entry.ns === 'session-delete'));
check('provides the controller as a service', provided.has('sessionDelete'), 'sessionDelete');

const byId = new Map();
for (const entry of registrations) {
  if (entry.declaration !== undefined) byId.set(`${entry.hole}:${entry.declaration.id}`, entry);
}
check('contributes the session-row menu item', byId.has('sidebar.workspaces.session.menu.item:session-delete'));
check('contributes nothing to the row hover actions',
  !byId.has('sidebar.workspaces.session.row.action:session-delete'),
  registrations.filter((entry) => entry.hole === 'sidebar.workspaces.session.row.action').map((entry) => entry.declaration?.id).join(', ') || 'none');
check('contributes the confirmation dialog', byId.has('shell.overlay:session-delete-confirm'));
check('contributes the completion notice', byId.has('shell.overlay:session-delete-toast'));

const controller = provided.get('sessionDelete');
check('controller exposes requestDelete/confirmDelete/settleRequest',
  typeof controller.requestDelete === 'function'
  && typeof controller.confirmDelete === 'function'
  && typeof controller.settleRequest === 'function');

// ── the Host fetch contract ────────────────────────────────────────────────

const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  return { ok: true, status: 200, json: async () => ({ ok: true, value: { sessionId: 'target', modifyOnly: true, locationSource: 'backend', paths: ['a', 'b'], warnings: [] } }) };
};

const plan = await controller.requestDelete('target', 'Test session');
check('preview posts to the host route', calls[0]?.url === 'api/session.delete', String(calls[0]?.url));
check('the request carries the confirmation header',
  calls[0]?.init.headers?.['x-dsh-session-delete-confirmation'] === 'delete-session',
  String(calls[0]?.init.headers?.['x-dsh-session-delete-confirmation']));
check('the request declares a JSON body',
  calls[0]?.init.headers?.['content-type'] === 'application/json',
  String(calls[0]?.init.headers?.['content-type']));
check('preview sends modifyOnly: true',
  JSON.parse(String(calls[0]?.init.body)).modifyOnly === true,
  String(calls[0]?.init.body));
check('preview returns the host plan', plan?.locationSource === 'backend' && plan?.modifyOnly === true, JSON.stringify(plan));

const request = controller.request.getSnapshot();
check('pending request carries the session and plan', request?.sessionId === 'target' && request?.plan !== undefined);
check('pending request carries the row title', request?.displayTitle === 'Test session');

await controller.confirmDelete('target');
check('confirm posts without modifyOnly', calls[1] !== undefined && !('modifyOnly' in JSON.parse(String(calls[1].init.body))));
check('confirm publishes a completion notice', controller.toast.getSnapshot()?.seq === 1);

controller.settleRequest();
check('settling clears the pending request', controller.request.getSnapshot() === null);

// ── refusal and failure paths ──────────────────────────────────────────────

globalThis.fetch = async () => ({
  ok: false,
  status: 409,
  json: async () => ({ ok: false, error: { code: 'session-delete/running', message: 'session is running' } }),
});
const refused = await controller.requestDelete('busy');
check('a refused preview resolves to undefined instead of throwing', refused === undefined);
check('a refused preview still opens the dialog with the host reason',
  controller.request.getSnapshot()?.error === 'session is running',
  String(controller.request.getSnapshot()?.error));
controller.settleRequest();

globalThis.fetch = async () => {
  throw new Error('network down');
};
const unreachable = await controller.requestDelete('offline');
check('an unreachable host resolves to undefined', unreachable === undefined);
check('an unreachable host surfaces its message',
  controller.request.getSnapshot()?.error === 'network down',
  String(controller.request.getSnapshot()?.error));
controller.settleRequest();

// ── row-level derived state ────────────────────────────────────────────────

/** The renderer names one injected hook source `use<Name>`; reproduce that here. */
const hookPropName = (name) => `use${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`;

/** The renderer wraps one observable source into a selector hook; reproduce that here. */
const observableHook = (source) => (select) => select(source.getSnapshot());

const rowInject = byId.get('sidebar.workspaces.session.menu.item:session-delete').declaration.inject();
const useDeleting = observableHook(rowInject.hooks.deleting);
check('the row inject declares the deleting hook', typeof rowInject.hooks.deleting?.getSnapshot === 'function');
check('the row inject declares the request action', typeof rowInject.requestDelete === 'function');
check('the row hook reads an empty deleting set at rest', useDeleting((set) => set.size) === 0);
const menuItem = byId.get('sidebar.workspaces.session.menu.item:session-delete').component;
const rendered = menuItem({
  sessionId: 'target',
  displayTitle: 'Test session',
  useDeleting,
  useMenuOpenState: (select) => select([false, () => {}]),
  requestDelete: () => {},
  t: (key) => key,
});
check('the menu row renders a danger MenuItemButton',
  rendered.type === primitives.MenuItemButton && rendered.props.danger === true,
  rendered.type?.displayName);
check('the menu row is labelled by the locale seat', rendered.props.children === 'menu.deleteSession');

const dialog = byId.get('shell.overlay:session-delete-confirm').component;
const dialogInject = byId.get('shell.overlay:session-delete-confirm').declaration.inject();
check('the dialog inject declares the pending-request hook', typeof dialogInject.hooks.deleteRequest?.getSnapshot === 'function');
check('the dialog inject declares the confirm action', typeof dialogInject.confirmDelete === 'function');
check('the hook prop names follow the renderer convention',
  hookPropName('deleteRequest') === 'useDeleteRequest' && hookPropName('deleting') === 'useDeleting');
check('the dialog renders nothing while no request is pending',
  dialog({ useDeleteRequest: (select) => select(null), settleRequest: () => {}, confirmDelete: () => {}, t: (key) => key }) === null);

// ── teardown ───────────────────────────────────────────────────────────────

for (const cleanup of cleanups) if (typeof cleanup === 'function') await cleanup();
check('mounting installed a disposal hook for in-flight requests', cleanups.some((entry) => typeof entry === 'function'));

const failed = checks.filter((entry) => !entry.ok);
console.log('');
console.log(failed.length === 0 ? `all ${String(checks.length)} checks passed` : `${String(failed.length)} of ${String(checks.length)} check(s) failed`);
process.exitCode = failed.length === 0 ? 0 : 1;
