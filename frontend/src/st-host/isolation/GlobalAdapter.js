/**
 * GlobalAdapter — install target abstraction for capability globals.
 * P0: WindowAdapter (same-window). P2: IframeAdapter swaps in without changing
 * CapabilityRegistry call sites.
 *
 * @module st-host/isolation/GlobalAdapter
 */

/**
 * @typedef {Object} GlobalAdapter
 * @property {(path: string, value: unknown) => void} defineGlobal
 * @property {(path: string) => void} deleteGlobal
 * @property {(source: string, prelude?: string) => string} [wrapModuleSource]
 * @property {() => void} teardown
 * @property {() => Map<string, unknown>} [getDefined]
 */

/**
 * @param {string} path
 * @returns {string}
 */
function topLevelKey(path) {
  const raw = String(path || '');
  const dot = raw.indexOf('.');
  return dot === -1 ? raw : raw.slice(0, dot);
}

/**
 * Create a WindowAdapter that tracks defined top-level keys for teardown.
 * Nested paths like `SillyTavern.foo` only write the top-level key for P0.
 *
 * @param {Record<string, unknown>} [target]
 * @returns {GlobalAdapter}
 */
export function createWindowAdapter(target = typeof window !== 'undefined' ? window : {}) {
  /** @type {Map<string, { existed: boolean, previous: unknown }>} */
  const defined = new Map();

  /**
   * @param {string} path
   * @param {unknown} value
   */
  function defineGlobal(path, value) {
    const key = topLevelKey(path);
    if (!key) return;

    if (!defined.has(key)) {
      const existed = Object.prototype.hasOwnProperty.call(target, key);
      defined.set(key, {
        existed,
        previous: existed ? target[key] : undefined,
      });
    }

    target[key] = value;
  }

  /**
   * @param {string} path
   */
  function deleteGlobal(path) {
    const key = topLevelKey(path);
    if (!key) return;

    const record = defined.get(key);
    if (record) {
      defined.delete(key);
      if (record.existed) {
        target[key] = record.previous;
      } else {
        try {
          delete target[key];
        } catch {
          target[key] = undefined;
        }
      }
      return;
    }

    try {
      delete target[key];
    } catch {
      target[key] = undefined;
    }
  }

  /**
   * Optionally prepend a prelude (storage namespace bridge, etc.) to module source.
   * @param {string} source
   * @param {string} [prelude]
   * @returns {string}
   */
  function wrapModuleSource(source, prelude = '') {
    const body = String(source ?? '');
    if (!prelude) return body;
    return `${prelude}\n${body}`;
  }

  function teardown() {
    const keys = [...defined.keys()];
    for (const key of keys) {
      deleteGlobal(key);
    }
    defined.clear();
  }

  return {
    defineGlobal,
    deleteGlobal,
    wrapModuleSource,
    teardown,
  };
}

/**
 * Create an IframeAdapter (PR-09).
 *
 * Capability install call sites stay the same (`defineGlobal` / `teardown`).
 * Without `allow-same-origin`, the frame contentWindow is opaque — defines are
 * kept in a parent-side registry (BridgeHost / bridge client proxies use the
 * allowlisted surface). When same-origin is enabled and a target window is
 * available, values are also written into the frame window.
 *
 * Parent Host chrome still uses WindowAdapter; IframeAdapter is for the card
 * frame install target when iframe mode is on.
 *
 * @param {{
 *   getTargetWindow?: () => (Window|Record<string, unknown>|null|undefined),
 *   parentRegistry?: Map<string, unknown>,
 * }} [options]
 * @returns {GlobalAdapter & {
 *   getDefined: () => Map<string, unknown>,
 *   flushToTarget: () => void,
 * }}
 */
export function createIframeAdapter(options = {}) {
  const getTargetWindow =
    typeof options.getTargetWindow === 'function'
      ? options.getTargetWindow
      : () => null;

  /** @type {Map<string, unknown>} */
  const registry =
    options.parentRegistry instanceof Map
      ? options.parentRegistry
      : new Map();

  /** @type {Map<string, { existed: boolean, previous: unknown }>} */
  const definedMeta = new Map();

  /**
   * @returns {Record<string, unknown>|null}
   */
  function resolveTarget() {
    try {
      const win = getTargetWindow();
      if (!win) return null;
      return /** @type {Record<string, unknown>} */ (win);
    } catch {
      return null;
    }
  }

  /**
   * @param {string} path
   * @param {unknown} value
   */
  function defineGlobal(path, value) {
    const key = topLevelKey(path);
    if (!key) return;

    registry.set(key, value);

    const target = resolveTarget();
    if (target) {
      if (!definedMeta.has(key)) {
        const existed = Object.prototype.hasOwnProperty.call(target, key);
        definedMeta.set(key, {
          existed,
          previous: existed ? target[key] : undefined,
        });
      }
      try {
        target[key] = value;
      } catch {
        // Opaque / restricted frame window — registry still holds the value.
      }
    }
  }

  /**
   * @param {string} path
   */
  function deleteGlobal(path) {
    const key = topLevelKey(path);
    if (!key) return;

    registry.delete(key);

    const target = resolveTarget();
    const record = definedMeta.get(key);
    definedMeta.delete(key);

    if (!target) return;

    try {
      if (record?.existed) {
        target[key] = record.previous;
      } else {
        try {
          delete target[key];
        } catch {
          target[key] = undefined;
        }
      }
    } catch {
      /* ignore restricted access */
    }
  }

  /**
   * Re-apply registry values onto the current target window (e.g. after iframe load).
   */
  function flushToTarget() {
    const target = resolveTarget();
    if (!target) return;
    for (const [key, value] of registry.entries()) {
      if (!definedMeta.has(key)) {
        const existed = Object.prototype.hasOwnProperty.call(target, key);
        definedMeta.set(key, {
          existed,
          previous: existed ? target[key] : undefined,
        });
      }
      try {
        target[key] = value;
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * @param {string} source
   * @param {string} [prelude]
   * @returns {string}
   */
  function wrapModuleSource(source, prelude = '') {
    const body = String(source ?? '');
    if (!prelude) return body;
    return `${prelude}\n${body}`;
  }

  function teardown() {
    const keys = [...registry.keys()];
    for (const key of keys) {
      deleteGlobal(key);
    }
    registry.clear();
    definedMeta.clear();
  }

  function getDefined() {
    return new Map(registry);
  }

  return {
    defineGlobal,
    deleteGlobal,
    wrapModuleSource,
    teardown,
    getDefined,
    flushToTarget,
  };
}

