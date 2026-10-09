/**
 * Browser half of `dsh-session-delete`.
 *
 * Contributes one Session-row menu action to the Workspace sidebar's own
 * extension seat, plus the confirmation dialog that gates the destructive call.
 * Everything the row needs arrives through the slot props (`sessionId`,
 * `displayTitle`) and through this plugin's own injected hooks; the only Host
 * call is the authenticated POST to `/api/session.delete` that the host half
 * registers.
 *
 * The Host drops the row from every open Session list by emitting
 * `api-session/removed`, so this half owns no Session-list state of its own.
 *
 * This file is a factory BODY, not a module. `scripts/build-client.mjs` wraps it
 * into the lazy-CJS factory DSH serves as `lib/client.js`, which supplies the
 * three names it binds — `require`, `exports` and `module` — using the same
 * self-contained shape every DSH client bundle uses:
 *
 *     window.__ModuleLoader__.load({ id, factory: (require) => {
 *       const module = { exports: {} }; const exports = module.exports;
 *       <this body>
 *       return module.exports;
 *     } })
 *
 * The loader calls the factory with `require` ALONE (`factory(this.makeRequire(…))`
 * in dsh-client-modules), so the module object has to be created in here; a
 * factory that expects the runtime to hand it one throws on undefined `module`.
 * @module dsh-session-delete/src/client
 */

const react = require('react');
const { jsx, jsxs, Fragment } = require('react/jsx-runtime');
const store = require('@deepseek-ai/dsh-client-store');
const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

// ── host contract ──────────────────────────────────────────────────────────

/** Document-relative form of the host route this half calls. */
const SESSION_DELETE_ROUTE = '/api/session.delete'.slice(1);

/** Locale namespace owned by this plugin. */
const NS = 'session-delete';

/** Menu row order: after pin (100), rename (200), fork (300) and archive (400). */
const MENU_ORDER = 500;

/** Simplified-Chinese copy. */
const ZH = {
  'menu.deleteSession': '永久删除',
  'dialog.title': '永久删除此会话？',
  'dialog.desc': '“{title}”的会话日志与投影缓存将被永久删除，无法恢复，并从工作区中移除。',
  'dialog.descUntitled': '此会话的会话日志与投影缓存将被永久删除，无法恢复，并从工作区中移除。',
  'dialog.action': '确认永久删除',
  'dialog.pending': '正在删除…',
  'dialog.cancel': '取消',
  'dialog.close': '关闭',
  'toast.deleted': '会话已永久删除',
};

/** English copy. */
const EN = {
  'menu.deleteSession': 'Delete permanently',
  'dialog.title': 'Permanently delete this session?',
  'dialog.desc': 'The session log and projection cache of “{title}” are permanently deleted and cannot be recovered; the session leaves its workspace.',
  'dialog.descUntitled': 'The session log and projection cache are permanently deleted and cannot be recovered; the session leaves its workspace.',
  'dialog.action': 'Confirm permanent deletion',
  'dialog.pending': 'Deleting…',
  'dialog.cancel': 'Cancel',
  'dialog.close': 'Close',
  'toast.deleted': 'Session permanently deleted',
};

/**
 * Read a message out of an unknown thrown value.
 * @param error - the thrown value.
 * @returns its message text.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Project one observable into another, recomputing only when the source
 * snapshot changes identity, so a Set-valued selector stays referentially
 * stable across unrelated renders.
 * @param source - the observable to project.
 * @param project - the projection.
 * @returns the projected observable.
 */
function derive(source, project) {
  let seen;
  let value;
  return {
    getSnapshot: () => {
      const snapshot = source.getSnapshot();
      if (value === undefined || snapshot !== seen) {
        seen = snapshot;
        value = project(snapshot);
      }
      return value;
    },
    subscribe: (listener) => source.subscribe(listener),
  };
}

// ── deletion controller ───────────────────────────────────────────────

/**
 * One in-flight delete preview and call. Owns the row-level store the menu
 * contribution reads, the pending request the dialog renders, and the
 * completion notice the toast renders.
 */
class SessionDeleteController {
  /** Per-Session delete state read by the menu row. */
  store = store.createSnapshotStore({ bySession: {} });

  /** The Session awaiting confirmation, or null. */
  request = store.createSnapshotStore(null);

  /** Completion notice; the sequence key replaces one notice with the next. */
  toast = store.createSnapshotStore(null);

  #inFlight = new Map();

  #toastSeq = 0;

  /**
   * Publish one Session's delete state, leaving other entries untouched.
   * @param sessionId - the Session to update.
   * @param entry - its next state.
   */
  #setEntry(sessionId, entry) {
    const current = this.store.getSnapshot();
    this.store.set({ bySession: { ...current.bySession, [String(sessionId)]: entry } });
  }

  /**
   * Whether one Session is mid-delete.
   * @param sessionId - the Session to test.
   * @returns true while its request is in flight.
   */
  isDeleting(sessionId) {
    return this.#inFlight.has(String(sessionId));
  }

  /**
   * Show the confirmation for one Session, resolving the Trash location it
   * reports. A refused preview still opens the dialog: the operator sees
   * the reason there instead of a silent no-op.
   * @param sessionId - the Session to delete.
   * @param displayTitle - its row title, when the seat supplies one.
   * @returns the resolved plan, or undefined when the preview was refused.
   */
  async requestDelete(sessionId, displayTitle) {
    this.#setEntry(sessionId, { status: 'planning', error: null });
    try {
      const plan = await this.#call(sessionId, true);
      this.request.set({ sessionId: String(sessionId), displayTitle, plan, error: null });
      return plan;
    } catch (error) {
      this.request.set({ sessionId: String(sessionId), displayTitle, plan: undefined, error: messageOf(error) });
      return undefined;
    } finally {
      this.#setEntry(sessionId, { status: 'idle', error: null });
    }
  }

  /**
   * Perform the confirmed delete. The Host answers after the durable
   * unaccounting and the move, so a resolved call is already final.
   * @param sessionId - the Session to delete.
   * @returns the Host outcome.
   */
  async confirmDelete(sessionId) {
    this.#setEntry(sessionId, { status: 'deleting', error: null });
    try {
      const value = await this.#call(sessionId, false);
      this.#toastSeq += 1;
      this.toast.set({ seq: this.#toastSeq });
      return value;
    } finally {
      this.#setEntry(sessionId, { status: 'idle', error: null });
    }
  }

  /**
   * Clear the pending request once its dialog settles.
   */
  settleRequest() {
    this.request.set(null);
  }

  /**
   * Abort every in-flight request; the Host observes each cancelled call.
   */
  dispose() {
    for (const controller of this.#inFlight.values()) controller.abort();
    this.#inFlight.clear();
  }

  /**
   * Call the Host route and unwrap its envelope.
   * @param sessionId - the Session to delete.
   * @param modifyOnly - preview the plan without touching the filesystem.
   * @returns the Host outcome value.
   * @throws {Error} carrying the Host's refusal message.
   */
  async #call(sessionId, modifyOnly) {
    const key = String(sessionId);
    const controller = new AbortController();
    this.#inFlight.set(key, controller);
    try {
      const response = await fetch(SESSION_DELETE_ROUTE, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The Host refuses a browser request without this header, which
          // no link or HTML form can set.
          'x-dsh-session-delete-confirmation': 'delete-session',
        },
        body: JSON.stringify({ sessionId: key, ...(modifyOnly ? { modifyOnly: true } : {}) }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => undefined);
      if (payload !== undefined && payload.ok === false) {
        throw new Error(payload.error?.message ?? `session delete failed with HTTP ${String(response.status)}`);
      }
      if (!response.ok) throw new Error(`session delete failed with HTTP ${String(response.status)}`);
      if (payload === undefined || payload.ok !== true) throw new Error('session delete returned an unrecognized response');
      return payload.value;
    } finally {
      this.#inFlight.delete(key);
    }
  }
}

// ── row contribution ──────────────────────────────────────────────────

/**
 * One Session row's delete menu entry: the only surface this plugin adds.
 *
 * `useMenuOpenState` is the one hook here that is NOT a selector: the parent
 * declares it as `(_standard, state) => () => state`, so it returns the
 * `[open, setOpen]` tuple itself (the shipped rows all destructure it that
 * way). Treating it like the observable hooks yields the boolean where the
 * setter is expected, and the `onSelect` that follows throws — which takes the
 * whole row menu down with it, not just this entry.
 * @param props - slot props, this plugin's hooks, the action, and the locale seat.
 * @returns the menu row.
 */
function DeleteSessionMenuItem({ sessionId, displayTitle, useDeleting, useMenuOpenState, requestDelete, t }) {
  // Checked before destructuring: the tuple is unpacked during RENDER, so a
  // seat that hands over anything else would throw there, where no handler of
  // this row can contain it. Losing the menu-close costs one click; losing the
  // row costs the menu.
  const openState = useMenuOpenState();
  const setMenuOpen = Array.isArray(openState) ? openState[1] : undefined;
  const deleting = useDeleting((set) => set.has(String(sessionId)));
  return jsx(primitives.MenuItemButton, {
    danger: true,
    disabled: deleting,
    icon: jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
    onSelect: () => {
      // Closing the menu and opening the confirmation are independent steps.
      // A failure in either must not escape into the menu's own event handler,
      // where it surfaces as an unhandled error and takes the row menu down.
      // The hook shape is checked rather than assumed: a deployment whose seat
      // hands over a different tuple leaves the menu open instead of throwing.
      if (typeof setMenuOpen === 'function') setMenuOpen(false);
      if (typeof requestDelete === 'function') void requestDelete(sessionId, displayTitle);
    },
    children: t('menu.deleteSession'),
  });
}

// ── dialog and notice ─────────────────────────────────────────────────

/**
 * The `shell.overlay` entry: nothing while no request is pending, otherwise
 * one dialog keyed by the Session so in-flight and error state die with it.
 * @param props - the pending-request hook, the settlement hop, the confirm
 *   action, and the locale seat.
 * @returns the open dialog, or null.
 */
function SessionDeleteConfirmDialog({ useDeleteRequest, settleRequest, confirmDelete, t }) {
  const request = useDeleteRequest((pending) => pending);
  if (request === null) return null;
  return jsx(DeleteConfirmForm, { request, settleRequest, confirmDelete, t }, request.sessionId);
}

/**
 * One request's dialog.
 * @param props - the request, its settlement, the confirm action, and the locale seat.
 * @returns the dialog.
 */
function DeleteConfirmForm({ request, settleRequest, confirmDelete, t }) {
  const [deleting, setDeleting] = react.useState(false);
  const [error, setError] = react.useState(request.error ?? null);
  const close = () => {
    if (deleting) return;
    settleRequest();
  };
  const confirm = () => {
    setDeleting(true);
    setError(null);
    confirmDelete(request.sessionId).then(() => {
      setDeleting(false);
      settleRequest();
    }, (reason) => {
      setDeleting(false);
      setError(messageOf(reason));
    });
  };
  const title = request.displayTitle;
  const description = title === undefined || title === ''
    ? t('dialog.descUntitled')
    : t('dialog.desc', { title });
  return jsxs(primitives.Modal, {
    open: true,
    onClose: close,
    closeLabel: t('dialog.close'),
    title: t('dialog.title'),
    description,
    footer: jsxs(Fragment, {
      children: [
        jsx(primitives.Button, { variant: 'outline', disabled: deleting, onClick: close, children: t('dialog.cancel') }),
        jsx(primitives.Button, {
          variant: 'outline',
          className: 'dsh-session-delete-confirm',
          disabled: deleting,
          onClick: confirm,
          children: t('dialog.action'),
        }),
      ],
    }),
    children: [
      deleting && jsx('div', { role: 'status', className: 'dsh-session-delete-status', children: t('dialog.pending') }),
      error !== null && jsx('div', { role: 'alert', className: 'dsh-session-delete-error', children: error }),
    ],
  });
}

/**
 * The completion notice shown after a delete settles.
 * @param props - the notice hook and the locale seat.
 * @returns the notice, or null.
 */
function SessionDeleteToast({ useDeleteToast, t }) {
  const toast = useDeleteToast((current) => current);
  if (toast === null) return null;
  return jsx(primitives.Toast, {
    text: t('toast.deleted'),
    tone: 'success',
    icon: jsx(primitives.IconTrashOutlineRegular, {}),
  }, `session-delete-toast-${String(toast.seq)}`);
}

// ── mount ─────────────────────────────────────────────────────────────

/** Styles for the two controls this plugin renders itself. */
const CSS = [
  '.dsh-session-delete-confirm{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary))}',
  '.dsh-session-delete-status{color:var(--dsw-alias-label-tertiary);font-size:13px}',
  '.dsh-session-delete-error{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary));font-size:13px}',
].join('');

/** Install the plugin's stylesheet once per bundle materialization. */
function installStyles() {
  const tagId = 'dsh-session-delete/styles.css';
  if (typeof document === 'undefined') return;
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-session-delete';
  tag.dataset.pluginCss = tagId;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

/**
 * Mount the delete action into the Workspace sidebar's Session-row menu.
 * @param ctx - the browser plugin context.
 */
function apply(ctx) {
  installStyles();
  const controller = new SessionDeleteController();
  const deleting = derive(controller.store, (snapshot) => {
    const ids = new Set();
    for (const [id, entry] of Object.entries(snapshot.bySession)) {
      if (entry.status === 'deleting') ids.add(id);
    }
    return ids;
  });
  const rowInjected = () => ({
    hooks: { deleting },
    // Returns the operation's promise rather than swallowing it: a caller that
    // awaits the action (a test, or a future surface) must be able to observe
    // when the preview settled. The menu item itself still fires and forgets.
    requestDelete: (sessionId, displayTitle) => controller.requestDelete(sessionId, displayTitle),
  });
  ctx.effect(() => () => {
    controller.dispose();
  }, 'session-delete: in-flight requests');

  // The dictionaries are what every surface below words itself with, so a
  // missing locale service is fatal to THIS plugin's usefulness, not to the
  // application: report it, clean up, and contribute nothing.
  const locale = readContextService(ctx, 'locale');
  if (typeof locale?.register !== 'function') {
    reportUnusable(ctx, 'the locale service is unavailable');
    controller.dispose();
    return;
  }
  ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'session-delete: browser dictionaries');

  const slots = readContextService(ctx, 'slots');
  if (typeof slots?.inject !== 'function' || typeof slots.register !== 'function') {
    reportUnusable(ctx, 'the slot registry is unavailable');
    controller.dispose();
    return;
  }

  // One guarded registration per surface. A boot audit fails the WHOLE
  // application when one plugin fiber ends up FAILED, so no single extension
  // point may be able to take Harness down with it.
  const contribute = (label, hole, declaration, component) => {
    try {
      slots.inject(hole, () => slots.register(declaration, component));
      return true;
    } catch (error) {
      reportUnusable(ctx, `${label} could not be registered: ${messageOf(error)}`);
      return false;
    }
  };
  const contributed = [
    contribute('the session-row menu entry', 'sidebar.workspaces.session.menu.item', {
      name: 'sidebar.workspaces.session.menu.item',
      id: 'session-delete',
      order: MENU_ORDER,
      locale: NS,
      inject: rowInjected,
    }, DeleteSessionMenuItem),
    contribute('the confirmation dialog', 'shell.overlay', {
      name: 'shell.overlay',
      id: 'session-delete-confirm',
      locale: NS,
      inject: () => ({
        hooks: { deleteRequest: controller.request },
        settleRequest: () => {
          controller.settleRequest();
        },
        confirmDelete: (sessionId) => controller.confirmDelete(sessionId),
      }),
    }, SessionDeleteConfirmDialog),
    contribute('the completion notice', 'shell.overlay', {
      name: 'shell.overlay',
      id: 'session-delete-toast',
      locale: NS,
      inject: () => ({
        hooks: { deleteToast: controller.toast },
      }),
    }, SessionDeleteToast),
  ];
  if (!contributed.some(Boolean)) controller.dispose();
}

/**
 * Read one context service without ever throwing.
 *
 * A Cordis context rejects reads of members the plugin did not declare, and a
 * throw inside `apply` ends this plugin's fiber — which the boot audit reports
 * as a blocked application. Both access shapes are attempted, and a refused
 * read is a missing service rather than a crash.
 * @param ctx - the browser plugin context.
 * @param key - the service key to read.
 * @returns the service, or undefined when it is unavailable.
 */
function readContextService(ctx, key) {
  try {
    const direct = ctx[key];
    if (direct !== undefined) return direct;
  } catch {
    // Reading the property itself can throw; the getter below is the fallback.
  }
  try {
    return typeof ctx.get === 'function' ? ctx.get(key) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Report one non-fatal problem through whatever logger the context offers.
 * @param ctx - the browser plugin context.
 * @param detail - the operator-facing sentence.
 */
function reportUnusable(ctx, detail) {
  try {
    const logger = readContextService(ctx, 'logger');
    logger?.warn?.(`session-delete: ${detail}; the delete action is not available`);
  } catch {
    // Logging is best-effort: it must never be the thing that fails a fiber.
  }
}

exports.apply = apply;
exports.name = 'session-delete';

/**
 * Services this browser half is activated for.
 *
 * Cordis holds the plugin out of ACTIVE until every named service exists, so
 * this list is what makes `slots` and `locale` non-optional inside `apply`.
 * Omitting it does NOT fail loudly: `apply` runs early, the services are still
 * undefined, and the only symptom is a plugin that mounts nothing — which is
 * exactly how the first working build shipped a boot with no menu entry. The
 * exported list mirrors the host half's shape (`exports.inject`), and the same
 * names appear in this package's `dsh.client.inject` so the module graph orders
 * the locale row first.
 *
 * @see dsh-session-log-export, whose browser half declares `['slots', 'locale']`
 */
exports.inject = ['slots', 'locale'];
