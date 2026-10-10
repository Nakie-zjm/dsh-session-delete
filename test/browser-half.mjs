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
 * Materialize the registered factory exactly as the runtime does.
 *
 * `dsh-client-modules` invokes `factory(this.makeRequire(ownerId, edges))` — the
 * require function and NOTHING else. Passing a second `module` argument here
 * would hide the only failure mode this test exists to catch: a factory that
 * expects the runtime to hand it a module object throws on an undefined
 * `module.exports`, which crashes the whole web boot for the user.
 * @returns the plugin's exports.
 */
function materialize() {
  return loaded.factory((specifier) => {
    if (!(specifier in modules)) throw new Error(`client bundle requested unknown module ${specifier}`);
    return modules[specifier];
  });
}

check('the factory is declared with exactly one parameter',
  loaded.factory.length === 1,
  `${String(loaded.factory.length)} parameters`);

const exports = materialize();
check('bundle exports apply()', typeof exports.apply === 'function');
check('bundle exports the plugin name', exports.name === 'session-delete', String(exports.name));
// Without this list Cordis activates the plugin before `slots` and `locale`
// exist; `apply` then contributes nothing and the boot still looks healthy.
check('bundle declares the services it is activated for',
  Array.isArray(exports.inject) && exports.inject.includes('slots') && exports.inject.includes('locale'),
  JSON.stringify(exports.inject));

// ── mount against a fake browser context ───────────────────────────────────

const registrations = [];
const dictionaries = [];
const cleanups = [];
const provided = new Map();

/** The context shim every mount test drives. */
const ctx = {
  provide: (key, value) => provided.set(key, value),
  effect: (factory) => {
    cleanups.push(factory());
  },
  locale: { register: (ns, dicts) => dictionaries.push({ ns, dicts }) },
  slots: {
    inject: (hole, factory) => {
      const dispose = factory();
      registrations.push({ hole, dispose, placed: true });
    },
    register: (declaration, component) => {
      const entry = { hole: declaration.name, declaration, component, placed: true };
      registrations.push(entry);
      return () => {
        entry.disposed = true;
      };
    },
  },
};

exports.apply(ctx);
check('registers a browser dictionary for its namespace', dictionaries.some((entry) => entry.ns === 'session-delete'));

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

// ── the guarded mount: a broken surface must not fail the whole boot ───────

{
  // The boot audit fails the ENTIRE application when one plugin fiber ends up
  // FAILED, so `apply` must survive a context that refuses reads and a slot
  // registry that rejects registrations.
  const hostile = new Proxy({}, {
    get(_target, property) {
      if (property === 'effect') return () => () => {};
      throw new Error(`cannot read undeclared context member ${String(property)}`);
    },
  });
  let threw;
  try {
    exports.apply(hostile);
  } catch (error) {
    threw = error;
  }
  check('apply survives a context that refuses every read', threw === undefined, String(threw?.message));

  const logged = [];
  const noSlots = {
    effect: () => () => {},
    logger: { warn: (message) => logged.push(String(message)) },
    locale: { register: () => () => {} },
    get: () => undefined,
  };
  let second;
  try {
    exports.apply(noSlots);
  } catch (error) {
    second = error;
  }
  check('apply survives a missing slot registry', second === undefined, String(second?.message));
  check('apply reports the missing slot registry',
    logged.some((line) => line.includes('slot registry is unavailable')),
    JSON.stringify(logged));

  const rejecting = [];
  const throwingSlots = {
    effect: () => () => {},
    logger: { warn: (message) => rejecting.push(String(message)) },
    locale: { register: () => () => {} },
    slots: {
      inject: () => { throw new Error('slot is not declared'); },
      register: () => { throw new Error('slot is not declared'); },
    },
  };
  let third;
  try {
    exports.apply(throwingSlots);
  } catch (error) {
    third = error;
  }
  check('apply survives a slot registry that rejects every registration', third === undefined, String(third?.message));
  check('apply reports the rejected registration',
    rejecting.some((line) => line.includes('could not be registered')),
    JSON.stringify(rejecting));
}

// ── the Host fetch contract, driven through the slot injects ───────────────

// The plugin contributes surfaces, not a service: every capability below is
// reached through the inject object of the surface that renders it, which is
// the only access path a real consumer has.
const rowInject = byId.get('sidebar.workspaces.session.menu.item:session-delete').declaration.inject();
const dialogInject = byId.get('shell.overlay:session-delete-confirm').declaration.inject();
const requestDelete = (sessionId, displayTitle) => rowInject.requestDelete(sessionId, displayTitle);
const pendingRequest = () => dialogInject.hooks.deleteRequest.getSnapshot();
const confirmDelete = (sessionId) => dialogInject.confirmDelete(sessionId);
const settleRequest = () => dialogInject.settleRequest();
const toastSnapshot = () => byId.get('shell.overlay:session-delete-toast').declaration.inject().hooks.deleteToast.getSnapshot();

const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  return { ok: true, status: 200, json: async () => ({ ok: true, value: { sessionId: 'target', modifyOnly: true, locationSource: 'backend', paths: ['a', 'b'], warnings: [] } }) };
};

const plan = await requestDelete('target', 'Test session');
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

const request = pendingRequest();
check('pending request carries the session and plan', request?.sessionId === 'target' && request?.plan !== undefined);
check('pending request carries the row title', request?.displayTitle === 'Test session');

await confirmDelete('target');
check('confirm posts without modifyOnly', calls[1] !== undefined && !('modifyOnly' in JSON.parse(String(calls[1].init.body))));
check('confirm publishes a completion notice', toastSnapshot()?.seq === 1);

settleRequest();
check('settling clears the pending request', pendingRequest() === null);

// ── refusal and failure paths ──────────────────────────────────────────────

globalThis.fetch = async () => ({
  ok: false,
  status: 409,
  json: async () => ({ ok: false, error: { code: 'session-delete/running', message: 'session is running' } }),
});
const refused = await requestDelete('busy');
check('a refused preview resolves to undefined instead of throwing', refused === undefined);
check('a refused preview still opens the dialog with the host reason',
  pendingRequest()?.error === 'session is running',
  String(pendingRequest()?.error));
settleRequest();

globalThis.fetch = async () => {
  throw new Error('network down');
};
const unreachable = await requestDelete('offline');
check('an unreachable host resolves to undefined', unreachable === undefined);
check('an unreachable host surfaces its message',
  pendingRequest()?.error === 'network down',
  String(pendingRequest()?.error));
settleRequest();

// ── row-level derived state ────────────────────────────────────────────────

/** The renderer names one injected hook source `use<Name>`; reproduce that here. */
const hookPropName = (name) => `use${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`;

/** The renderer wraps one observable SOURCE into a selector hook; reproduce that here. */
const observableHook = (source) => (select) => select(source.getSnapshot());

/**
 * The menu-open seat, which is NOT an observable: the parent declares it as
 * `(_standard, state) => () => state`, so calling the prop returns the
 * `[open, setOpen]` tuple and ignores any selector. Reproducing that exact
 * shape is the whole point — a selector-shaped mock accepted the previous,
 * broken `useMenuOpenState((state) => state[1])` call and the resulting
 * `setMenuOpen is not a function` only appeared in the real app.
 * @param closed - the setter the row is expected to call.
 * @returns the opener tuple factory, plus a call counter.
 */
function menuOpenSeat(closed) {
  const seat = { calls: 0 };
  seat.useMenuOpenState = () => {
    seat.calls += 1;
    return [true, closed];
  };
  return seat;
}

const useDeleting = observableHook(rowInject.hooks.deleting);
check('the row inject declares the deleting hook', typeof rowInject.hooks.deleting?.getSnapshot === 'function');
check('the row inject declares the request action', typeof rowInject.requestDelete === 'function');
check('the row hook reads an empty deleting set at rest', useDeleting((set) => set.size) === 0);

const menuItem = byId.get('sidebar.workspaces.session.menu.item:session-delete').component;
{
  const seat = menuOpenSeat(() => { seat.closedCount = (seat.closedCount ?? 0) + 1; });
  const requested = [];
  const rendered = menuItem({
    sessionId: 'target',
    displayTitle: 'Test session',
    useDeleting,
    useMenuOpenState: seat.useMenuOpenState,
    requestDelete: (sessionId, displayTitle) => { requested.push([sessionId, displayTitle]); },
    t: (key) => key,
  });
  check('the menu row renders a danger MenuItemButton',
    rendered.type === primitives.MenuItemButton && rendered.props.danger === true,
    rendered.type?.displayName);
  check('the menu row is labelled by the locale seat', rendered.props.children === 'menu.deleteSession');

  // Selecting the row is the interaction that failed in the app: it must close
  // the menu and start the action without throwing.
  let threw;
  try {
    rendered.props.onSelect();
  } catch (error) {
    threw = error;
  }
  check('selecting the row does not throw', threw === undefined, String(threw?.message));
  check('selecting the row closes the menu', seat.closedCount === 1, `closed ${String(seat.closedCount ?? 0)}x`);
  check('selecting the row starts the delete for that session',
    requested.length === 1 && requested[0][0] === 'target' && requested[0][1] === 'Test session',
    JSON.stringify(requested));
}

{
  // A seat that hands over something other than the tuple must leave the menu
  // alone rather than throw into the menu's own event handler.
  const rendered = menuItem({
    sessionId: 'target',
    displayTitle: 'Test session',
    useDeleting,
    useMenuOpenState: () => undefined,
    requestDelete: undefined,
    t: (key) => key,
  });
  let threw;
  try {
    rendered.props.onSelect();
  } catch (error) {
    threw = error;
  }
  check('selecting the row survives a seat that returns no tuple', threw === undefined, String(threw?.message));
}

const dialog = byId.get('shell.overlay:session-delete-confirm').component;

check('the dialog inject declares the pending-request hook', typeof dialogInject.hooks.deleteRequest?.getSnapshot === 'function');
check('the dialog inject declares the confirm action', typeof dialogInject.confirmDelete === 'function');
check('the hook prop names follow the renderer convention',
  hookPropName('deleteRequest') === 'useDeleteRequest' && hookPropName('deleting') === 'useDeleting');
check('the dialog renders nothing while no request is pending',
  dialog({ useDeleteRequest: (select) => select(null), settleRequest: () => {}, confirmDelete: () => {}, t: (key) => key }) === null);

// ── teardown ───────────────────────────────────────────────────────────────

{
  // Disposing the mount must abort a delete still in flight; otherwise a
  // plugin that is gone keeps a request (and its response handler) alive.
  let aborted = false;
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      aborted = true;
      reject(new Error('aborted'));
    });
  });
  const pending = requestDelete('pending-session');
  for (const cleanup of cleanups) if (typeof cleanup === 'function') await cleanup();
  await pending;
  check('disposing the mount aborts an in-flight request', aborted === true);
}

for (const cleanup of cleanups) if (typeof cleanup === 'function') await cleanup();
check('mounting installed a disposal hook for in-flight requests', cleanups.some((entry) => typeof entry === 'function'));

const failed = checks.filter((entry) => !entry.ok);
console.log('');
console.log(failed.length === 0 ? `all ${String(checks.length)} checks passed` : `${String(failed.length)} of ${String(checks.length)} check(s) failed`);
process.exitCode = failed.length === 0 ? 0 : 1;
