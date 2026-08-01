/**
 * EventBus — TH-compatible pub/sub for ST host runtime.
 * Used by eventOn / eventEmit / eventSource and getContext().eventSource.
 *
 * @module st-host/context/EventBus
 */

/**
 * @typedef {Object} EventSubscription
 * @property {() => void} stop
 */

/**
 * @typedef {Object} EventBus
 * @property {(event: string, listener: Function) => EventSubscription} on
 * @property {(event: string, listener: Function) => EventSubscription} once
 * @property {(event: string, listener: Function) => void} off
 * @property {(event: string, listener: Function) => void} removeListener
 * @property {(event: string, ...args: unknown[]) => Promise<void>} emit
 * @property {() => void} clear
 * @property {() => { on: Function, once: Function, emit: Function, removeListener: Function }} asEventSource
 * @property {(event: string, listener: Function) => EventSubscription} eventOn
 * @property {(event: string, listener: Function) => EventSubscription} eventOnce
 * @property {(event: string, ...args: unknown[]) => Promise<void>} eventEmit
 * @property {(event: string, listener: Function) => void} eventRemoveListener
 */

/**
 * Create an in-memory event bus (per-session / per-runtime).
 * @param {{ thisArg?: object, debug?: boolean }} [options]
 * @returns {EventBus}
 */
export function createEventBus(options = {}) {
  const thisArg = options.thisArg ?? null;
  const debug = !!options.debug;

  /** @type {Map<string, Function[]>} */
  const listeners = new Map();

  /**
   * @param {string} event
   * @returns {Function[]}
   */
  function listFor(event) {
    const key = String(event);
    if (!listeners.has(key)) listeners.set(key, []);
    return listeners.get(key);
  }

  /**
   * @param {string} event
   * @param {Function} listener
   * @returns {EventSubscription}
   */
  function on(event, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('EventBus.on: listener must be a function');
    }
    listFor(event).push(listener);
    return {
      stop() {
        off(event, listener);
      },
    };
  }

  /**
   * @param {string} event
   * @param {Function} listener
   * @returns {EventSubscription}
   */
  function once(event, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('EventBus.once: listener must be a function');
    }
    const wrapped = (...args) => {
      off(event, wrapped);
      return listener.apply(thisArg ?? undefined, args);
    };
    return on(event, wrapped);
  }

  /**
   * @param {string} event
   * @param {Function} listener
   */
  function off(event, listener) {
    const key = String(event);
    const current = listeners.get(key);
    if (!current) return;
    listeners.set(
      key,
      current.filter((item) => item !== listener)
    );
  }

  /**
   * @param {string} event
   * @param {...unknown} args
   */
  async function emit(event, ...args) {
    if (debug) {
      console.debug('[EventBus] emit:', { event, args });
    }
    const snapshot = [...listFor(event)];
    for (const listener of snapshot) {
      await listener.apply(thisArg ?? undefined, args);
    }
  }

  function clear() {
    listeners.clear();
  }

  function asEventSource() {
    return {
      on,
      once,
      emit,
      removeListener: off,
    };
  }

  return {
    on,
    once,
    off,
    removeListener: off,
    emit,
    clear,
    asEventSource,
    // TavernHelper aliases
    eventOn: on,
    eventOnce: once,
    eventEmit: emit,
    eventRemoveListener: off,
  };
}
