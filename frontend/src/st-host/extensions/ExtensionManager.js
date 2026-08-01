/**
 * ExtensionManager — P2 local-extension skeleton (§5.4).
 *
 * Scope: local manifest (name, loading_order, entry) + activate/deactivate
 * + requiresReload marker + CapabilityRegistry integration (declared capability ids).
 *
 * Not in scope (P4): full ST extension store, git install, third-party CDN.
 *
 * Manifest shape (Conclave local + ST-compatible aliases):
 * ```json
 * {
 *   "name": "my-ext",
 *   "display_name": "My Extension",
 *   "loading_order": 10,
 *   "entry": "index.js",
 *   "js": "index.js",
 *   "capabilities": ["ext.my-ext"],
 *   "requiresReload": false,
 *   "hooks": { "activate": "activate", "deactivate": "deactivate" }
 * }
 * ```
 *
 * Remote entry URLs are **default-deny** (same pattern as ScriptRunner PR-08).
 * Override via `allowRemoteEntry` option or
 * `localStorage['conclave:feature:allow_remote_extension_entry'] === '1'`.
 *
 * @module st-host/extensions/ExtensionManager
 */

import { isRemoteScriptUrl } from '../ScriptRunner.js';

/**
 * @typedef {Object} ExtensionManifest
 * @property {string} name
 * @property {string} [display_name]
 * @property {number} [loading_order]
 * @property {string} [entry]   Conclave preferred entry field
 * @property {string} [js]      ST-compatible alias for entry
 * @property {string[]} [capabilities]  Capability ids this extension provides
 * @property {string[]} [capability_ids]  Alias for capabilities
 * @property {boolean} [requiresReload]
 * @property {{ activate?: string, deactivate?: string }} [hooks]
 * @property {string} [version]
 * @property {string[]} [requires]
 */

/**
 * @typedef {Object} ExtensionRecord
 * @property {string} name
 * @property {ExtensionManifest} manifest
 * @property {string|null} entry
 * @property {number} loading_order
 * @property {string[]} capabilityIds
 * @property {boolean} active
 * @property {object|null} module
 * @property {object|null} [context]
 * @property {Array<() => void | Promise<void>>} teardowns
 * @property {boolean} requiresReloadOnChange
 */

/**
 * @typedef {Object} ExtensionManagerOptions
 * @property {{ get?: Function, register?: Function, unregister?: Function, isSeed?: Function }} [catalog]
 *   CapabilityCatalog — extensions may register capability descriptors on activate.
 * @property {{ install?: Function, getReport?: Function, noteExtensionCaps?: Function, clearExtensionCaps?: Function }} [registry]
 *   Optional CapabilityRegistry; when present, declared caps are noted on the report.
 * @property {(entry: string, record: ExtensionRecord) => Promise<object|Function|null|undefined>} [loadEntry]
 *   Module loader (injectable for tests). Default: dynamic import(entry) after remote check.
 * @property {boolean|(() => boolean)} [allowRemoteEntry]
 *   Allow http(s)/protocol-relative entry (default false; flag override below).
 * @property {(record: ExtensionRecord, module: object) => object} [createActivateContext]
 *   Extra context passed to extension activate hooks.
 */

/**
 * Feature flag: allow remote extension entry URLs (default false).
 * `localStorage['conclave:feature:allow_remote_extension_entry'] === '1'`.
 *
 * @param {Storage|null|undefined} [storage]
 * @returns {boolean}
 */
export function isRemoteExtensionEntryAllowed(storage) {
  try {
    const store =
      storage ||
      (typeof globalThis !== 'undefined' ? globalThis.localStorage : null);
    return store?.getItem?.('conclave:feature:allow_remote_extension_entry') === '1';
  } catch {
    return false;
  }
}

/**
 * Normalize raw manifest into a stable record.
 * @param {ExtensionManifest|object} raw
 * @param {string} [fallbackName]
 * @returns {ExtensionRecord}
 */
export function normalizeManifest(raw, fallbackName = 'unnamed') {
  const src = raw && typeof raw === 'object' ? raw : {};
  const name = String(src.name || src.display_name || fallbackName || 'unnamed');
  const entry =
    src.entry != null && src.entry !== ''
      ? String(src.entry)
      : src.js != null && src.js !== ''
        ? String(src.js)
        : null;
  const loading_order = Number.isFinite(Number(src.loading_order))
    ? Number(src.loading_order)
    : 100;
  const capabilityIds = Array.isArray(src.capabilities)
    ? src.capabilities.map(String)
    : Array.isArray(src.capability_ids)
      ? src.capability_ids.map(String)
      : [];
  const requiresReloadOnChange = !!(src.requiresReload || src.requires_reload);

  /** @type {ExtensionManifest} */
  const manifest = {
    ...src,
    name,
    display_name: src.display_name || name,
    loading_order,
    entry: entry || undefined,
    capabilities: capabilityIds,
    requiresReload: requiresReloadOnChange,
  };

  return {
    name,
    manifest,
    entry,
    loading_order,
    capabilityIds,
    active: false,
    module: null,
    context: null,
    teardowns: [],
    requiresReloadOnChange,
  };
}

/**
 * Default entry loader — dynamic import after remote-deny gate (callers should also gate).
 * @param {string} entry
 * @returns {Promise<object>}
 */
async function defaultLoadEntry(entry) {
  return import(/* @vite-ignore */ entry);
}

/**
 * Resolve activate / deactivate hook from module + manifest.hooks.
 * @param {object|Function|null|undefined} mod
 * @param {string} [hookName]
 * @param {'activate'|'deactivate'} kind
 * @returns {Function|null}
 */
function resolveHook(mod, hookName, kind) {
  if (!mod) return null;
  if (typeof mod === 'function' && kind === 'activate') return mod;

  const named = hookName && typeof mod[hookName] === 'function' ? mod[hookName] : null;
  if (named) return named.bind(mod);

  if (typeof mod[kind] === 'function') return mod[kind].bind(mod);
  if (kind === 'activate' && typeof mod.init === 'function') return mod.init.bind(mod);
  if (kind === 'activate' && typeof mod.default === 'function') return mod.default.bind(mod);
  if (
    kind === 'activate' &&
    mod.default &&
    typeof mod.default === 'object' &&
    typeof mod.default.activate === 'function'
  ) {
    return mod.default.activate.bind(mod.default);
  }
  if (
    kind === 'deactivate' &&
    mod.default &&
    typeof mod.default === 'object' &&
    typeof mod.default.deactivate === 'function'
  ) {
    return mod.default.deactivate.bind(mod.default);
  }
  return null;
}

/**
 * Build a safe capability descriptor; fill missing install() so mid-activate does not throw.
 * @param {string} id
 * @param {string} extensionName
 * @param {object} [partial]
 */
function ensureDescriptor(id, extensionName, partial = {}) {
  if (partial && typeof partial.install === 'function') {
    return { ...partial, id, kind: partial.kind || 'extension', requiredByDefault: false };
  }
  return {
    id,
    kind: 'extension',
    requiredByDefault: false,
    install() {
      return {
        status: 'ready',
        detail: `extension:${extensionName} provides ${id}`,
        providedGlobals: [],
      };
    },
  };
}

/**
 * @param {ExtensionManagerOptions} [options]
 */
export function createExtensionManager(options = {}) {
  const {
    catalog = null,
    registry = null,
    loadEntry = defaultLoadEntry,
    allowRemoteEntry = false,
    createActivateContext = null,
  } = options;

  /** @type {Map<string, ExtensionRecord>} */
  const byName = new Map();

  /** Global requiresReload marker (ST-style). */
  let requiresReload = false;

  function resolveAllowRemote() {
    if (typeof allowRemoteEntry === 'function') return !!allowRemoteEntry();
    if (allowRemoteEntry === true) return true;
    return isRemoteExtensionEntryAllowed();
  }

  /**
   * Assert entry is allowed before dynamic import / custom loadEntry.
   * @param {string} entry
   */
  function assertEntryAllowed(entry) {
    if (isRemoteScriptUrl(entry) && !resolveAllowRemote()) {
      throw new Error(
        `ExtensionManager: remote entry denied by default (set conclave:feature:allow_remote_extension_entry=1 or allowRemoteEntry): ${entry}`
      );
    }
  }

  /**
   * Register a local extension from an in-memory manifest (+ optional preloaded module).
   * Does not activate.
   *
   * @param {ExtensionManifest|object} manifest
   * @param {{ module?: object|Function, name?: string }} [opts]
   * @returns {ExtensionRecord}
   */
  function register(manifest, opts = {}) {
    const record = normalizeManifest(manifest, opts.name);
    if (opts.module != null) {
      record.module = opts.module;
    }
    const existing = byName.get(record.name);
    if (existing?.active) {
      throw new Error(
        `ExtensionManager.register: cannot replace active extension "${record.name}" — deactivate first`
      );
    }
    byName.set(record.name, record);
    return record;
  }

  /**
   * @param {string} name
   * @returns {ExtensionRecord|undefined}
   */
  function get(name) {
    return byName.get(String(name || ''));
  }

  /**
   * @returns {ExtensionRecord[]}
   */
  function list() {
    return [...byName.values()].sort(
      (a, b) =>
        a.loading_order - b.loading_order ||
        String(a.manifest.display_name || a.name).localeCompare(
          String(b.manifest.display_name || b.name)
        )
    );
  }

  /**
   * @returns {boolean}
   */
  function getRequiresReload() {
    return requiresReload;
  }

  function markRequiresReload() {
    requiresReload = true;
  }

  function clearRequiresReload() {
    requiresReload = false;
  }

  /**
   * @param {ExtensionRecord} record
   */
  async function runTeardowns(record) {
    for (let i = record.teardowns.length - 1; i >= 0; i -= 1) {
      try {
        await Promise.resolve(record.teardowns[i]());
      } catch (error) {
        console.warn(`[ExtensionManager] teardown for "${record.name}" failed:`, error);
      }
    }
    record.teardowns.length = 0;
  }

  /**
   * Register capability descriptors declared by the extension module onto the catalog.
   * Module may export `capabilities: CapabilityDescriptor[]` or `getCapabilities()`.
   * Missing install() is auto-synthesized (never throws mid-activate for that reason).
   * Built-in seed ids are skipped with a warning (catalog also refuses clobber).
   *
   * @param {ExtensionRecord} record
   * @param {object} mod
   * @returns {string[]} capability ids actually registered
   */
  function installDeclaredCapabilities(record, mod) {
    const ids = record.capabilityIds;
    /** @type {string[]} */
    const registered = [];
    if (!ids.length) return registered;

    /** @type {object[]} */
    let descriptors = [];
    if (typeof mod.getCapabilities === 'function') {
      const got = mod.getCapabilities();
      if (Array.isArray(got)) descriptors = got;
    } else if (Array.isArray(mod.capabilities)) {
      descriptors = mod.capabilities;
    }

    for (const id of ids) {
      if (catalog && typeof catalog.isSeed === 'function' && catalog.isSeed(id)) {
        console.warn(
          `[ExtensionManager] extension "${record.name}" cannot claim built-in capability "${id}" — skipped`
        );
        continue;
      }

      const partial = descriptors.find((d) => d && d.id === id) || {};
      const desc = ensureDescriptor(id, record.name, partial);

      if (catalog && typeof catalog.register === 'function') {
        try {
          catalog.register(desc);
          registered.push(id);
        } catch (error) {
          console.warn(
            `[ExtensionManager] catalog.register(${id}) failed:`,
            error instanceof Error ? error.message : error
          );
          continue;
        }
      } else {
        registered.push(id);
      }

      if (registry && typeof registry.noteExtensionCaps === 'function') {
        registry.noteExtensionCaps(record.name, id, 'ready');
      }
    }

    // Remember what we actually registered so deactivate can reverse accurately.
    record._registeredCapabilityIds = registered;
    return registered;
  }

  /**
   * Unregister extension capability ids from catalog + clear registry notes.
   * @param {ExtensionRecord} record
   */
  function uninstallDeclaredCapabilities(record) {
    const ids = Array.isArray(record._registeredCapabilityIds)
      ? record._registeredCapabilityIds
      : record.capabilityIds;

    for (const id of ids) {
      if (catalog && typeof catalog.unregister === 'function') {
        try {
          catalog.unregister(id);
        } catch (error) {
          console.warn(
            `[ExtensionManager] catalog.unregister(${id}) failed:`,
            error
          );
        }
      }
      if (registry && typeof registry.clearExtensionCaps === 'function') {
        registry.clearExtensionCaps(record.name, id);
      }
    }
    record._registeredCapabilityIds = [];
  }

  /**
   * Activate an extension by name (load entry if needed, run activate hook).
   * On failure after the hook starts, teardowns + partial caps are cleaned up.
   * @param {string} name
   * @returns {Promise<ExtensionRecord>}
   */
  async function activate(name) {
    const key = String(name || '');
    const record = byName.get(key);
    if (!record) {
      throw new Error(`ExtensionManager.activate: unknown extension "${key}"`);
    }
    if (record.active) {
      return record;
    }

    let mod = record.module;
    if (mod == null) {
      if (!record.entry) {
        throw new Error(
          `ExtensionManager.activate: extension "${key}" has no entry and no preloaded module`
        );
      }
      assertEntryAllowed(record.entry);
      mod = await loadEntry(record.entry, record);
      record.module = mod;
    }

    const activateHookName = record.manifest.hooks?.activate;
    const activateFn = resolveHook(mod, activateHookName, 'activate');

    const baseCtx = {
      name: record.name,
      manifest: record.manifest,
      registerTeardown(fn) {
        if (typeof fn === 'function') record.teardowns.push(fn);
      },
      markRequiresReload,
      getRequiresReload,
      catalog,
      registry,
    };
    const ctx =
      typeof createActivateContext === 'function'
        ? { ...baseCtx, ...createActivateContext(record, mod) }
        : baseCtx;

    try {
      if (activateFn) {
        await Promise.resolve(activateFn(ctx));
      }

      installDeclaredCapabilities(record, mod && typeof mod === 'object' ? mod : {});

      record.active = true;
      record.context = ctx;
      return record;
    } catch (error) {
      // Partial activate: always run hook teardowns + reverse any caps that got in.
      try {
        await runTeardowns(record);
      } catch {
        /* runTeardowns already swallows per-fn */
      }
      try {
        uninstallDeclaredCapabilities(record);
      } catch {
        /* ignore */
      }
      record.active = false;
      record.context = null;
      throw error;
    }
  }

  /**
   * Deactivate an extension: run deactivate hook + teardowns + capability unregister.
   * @param {string} name
   * @returns {Promise<ExtensionRecord>}
   */
  async function deactivate(name) {
    const key = String(name || '');
    const record = byName.get(key);
    if (!record) {
      throw new Error(`ExtensionManager.deactivate: unknown extension "${key}"`);
    }
    if (!record.active) {
      // Still drain stranded teardowns from a failed activate that left debris
      // (should be rare after activate-catch cleanup).
      if (record.teardowns.length) {
        await runTeardowns(record);
      }
      return record;
    }

    const mod = record.module;
    const deactivateHookName = record.manifest.hooks?.deactivate;
    const deactivateFn = resolveHook(mod, deactivateHookName, 'deactivate');

    if (deactivateFn) {
      try {
        await Promise.resolve(deactivateFn(record.context || { name: record.name }));
      } catch (error) {
        console.warn(`[ExtensionManager] deactivate hook for "${key}" failed:`, error);
      }
    }

    await runTeardowns(record);
    uninstallDeclaredCapabilities(record);

    record.active = false;
    record.context = null;

    if (record.requiresReloadOnChange) {
      requiresReload = true;
    }

    return record;
  }

  /**
   * Activate all registered extensions sorted by loading_order.
   * @returns {Promise<ExtensionRecord[]>}
   */
  async function activateAll() {
    const ordered = list();
    const results = [];
    for (const record of ordered) {
      // loading_order is sequential by design
      results.push(await activate(record.name));
    }
    return results;
  }

  /**
   * Deactivate all active extensions (reverse loading_order).
   * @returns {Promise<ExtensionRecord[]>}
   */
  async function deactivateAll() {
    const ordered = list().reverse();
    const results = [];
    for (const record of ordered) {
      if (!record.active) continue;
      results.push(await deactivate(record.name));
    }
    return results;
  }

  return {
    register,
    get,
    list,
    activate,
    deactivate,
    activateAll,
    deactivateAll,
    getRequiresReload,
    markRequiresReload,
    clearRequiresReload,
    normalizeManifest,
    /** @internal test helper */
    _resolveAllowRemote: resolveAllowRemote,
  };
}
