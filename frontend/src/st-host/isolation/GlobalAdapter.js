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
 */

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
   * @returns {string}
   */
  function topLevelKey(path) {
    const raw = String(path || '');
    const dot = raw.indexOf('.');
    return dot === -1 ? raw : raw.slice(0, dot);
  }

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
