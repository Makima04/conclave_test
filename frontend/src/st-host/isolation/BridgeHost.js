/**
 * BridgeHost — parent-side BridgeProtocol v1 dispatcher (PR-09).
 *
 * Listens for postMessage from the card iframe, enforces the method allowlist,
 * and invokes runtime surfaces (TH / MVU / EventBus / scoped storage).
 *
 * Security notes:
 * - Requests are rejected while no frame window is bound, and when
 *   `event.source !== frameWin` once bound.
 * - Parent→opaque-frame posts still use targetOrigin `*` (browser limitation for
 *   unique opaque origins / srcdoc). Frame→parent uses embedded parent origin
 *   when available (see bridgeClientSource).
 * - EventBus channel names are not allowlisted: under iframe mode the card may
 *   on/emit any host EventBus event (documented residual; see architecture ADR).
 *
 * @module st-host/isolation/BridgeHost
 */

import {
  createResponse,
  validateRequest,
  isBridgeRequest,
  BRIDGE_PROTOCOL_VERSION,
} from './BridgeProtocol.js';
import { createScopedLocalStorage } from '../../shared/scopedStorage.js';

/**
 * @typedef {Object} BridgeHostOptions
 * @property {() => string} getSessionId
 * @property {() => string} [getStorageNamespace]
 * @property {() => object} [getSurfaces]  // { tavernHelper, mvu, eventApi, ... }
 * @property {() => object|null} [getEventBus]
 * @property {() => Window|null} [getFrameWindow]
 * @property {(level: string, message: string, meta?: object) => void} [log]
 * @property {Window} [targetWindow]  // where to attach message listener (default: window)
 * @property {boolean} [allowGlobalFallback]  // opt-in: th.call falls back to globalThis
 * @property {boolean} [requireFrameSource]  // default true: reject when frame unbound / source mismatch
 */

/**
 * @param {BridgeHostOptions} options
 */
export function createBridgeHost(options) {
  if (!options || typeof options.getSessionId !== 'function') {
    throw new Error('createBridgeHost: getSessionId is required');
  }

  const getSessionId = options.getSessionId;
  const getStorageNamespace =
    typeof options.getStorageNamespace === 'function'
      ? options.getStorageNamespace
      : () => 'conclave:session:default:card:current:';
  const getSurfaces =
    typeof options.getSurfaces === 'function' ? options.getSurfaces : () => ({});
  const getEventBus =
    typeof options.getEventBus === 'function' ? options.getEventBus : () => null;
  const getFrameWindow =
    typeof options.getFrameWindow === 'function'
      ? options.getFrameWindow
      : () => null;
  const allowGlobalFallback = !!options.allowGlobalFallback;
  const requireFrameSource = options.requireFrameSource !== false;
  const log =
    options.log ||
    ((level, message, meta) => {
      const fn = level === 'error' ? console.error : console.debug;
      fn(`[conclave:bridge] ${message}`, meta || '');
    });

  const listenTarget =
    options.targetWindow ||
    (typeof window !== 'undefined' ? window : null);

  /** @type {Map<string, { event: string, stop?: () => void }>} */
  const listenerRegistry = new Map();

  /** @type {((event: MessageEvent) => void)|null} */
  let onMessage = null;
  let tornDown = false;
  /** Bumped on resetFrameListeners so late callbacks from old gens are ignored. */
  let frameGeneration = 0;

  /**
   * @param {Window|null|undefined} frameWin
   * @param {object} envelope
   */
  function postToFrame(frameWin, envelope) {
    if (!frameWin || typeof frameWin.postMessage !== 'function') return;
    try {
      // Residual: opaque srcdoc frames require '*'; same-origin frames could use
      // a concrete origin, but we keep '*' for both paths for simplicity.
      frameWin.postMessage(envelope, '*');
    } catch (error) {
      log('error', 'postToFrame failed', { error: String(error) });
    }
  }

  /**
   * @param {MessageEvent} event
   * @param {object} response
   */
  function reply(event, response) {
    const source = event.source;
    if (source && typeof source.postMessage === 'function') {
      try {
        // Prefer event.origin when it is a concrete origin; fall back to '*'.
        const targetOrigin =
          event.origin && event.origin !== 'null' ? event.origin : '*';
        source.postMessage(response, targetOrigin);
      } catch {
        try {
          source.postMessage(response, '*');
        } catch (err2) {
          log('error', 'reply failed', { error: String(err2) });
        }
      }
    }
  }

  /**
   * Stop all parent EventBus subscriptions registered for the current frame.
   * Call on every srcdoc remount so stale event.cb handlers cannot leak.
   */
  function resetFrameListeners() {
    frameGeneration += 1;
    for (const record of listenerRegistry.values()) {
      try {
        record.stop?.();
      } catch {
        /* ignore */
      }
    }
    listenerRegistry.clear();
  }

  /**
   * @param {string} method
   * @param {unknown[]} args
   */
  async function dispatchThCall(method, args) {
    // Functions cannot cross postMessage. Client applies updateVariablesWith
    // via getVariables+replaceVariables; reject any direct host invocation.
    if (method === 'updateVariablesWith') {
      const updater = args[0];
      if (typeof updater !== 'function') {
        throw Object.assign(
          new Error(
            'updateVariablesWith: function updaters cannot cross postMessage; ' +
              'bridge client applies them client-side (getVariables → updater → replaceVariables)',
          ),
          { code: 'non_serializable_updater' },
        );
      }
    }

    const surfaces = getSurfaces() || {};
    const th = surfaces.tavernHelper || {};
    const fn = th[method];
    if (typeof fn === 'function') {
      return fn.apply(th, args);
    }

    if (allowGlobalFallback) {
      const globalFn =
        typeof globalThis !== 'undefined' ? globalThis[method] : undefined;
      if (typeof globalFn === 'function') {
        return globalFn.apply(globalThis, args);
      }
    }

    throw Object.assign(new Error(`th.call method unavailable: ${method}`), {
      code: 'method_unavailable',
    });
  }

  /**
   * @param {string} method
   * @param {unknown[]} args
   */
  async function dispatchMvuCall(method, args) {
    const surfaces = getSurfaces() || {};
    const mvu = surfaces.mvu || {};
    if (method === 'events') {
      return mvu.events && typeof mvu.events === 'object'
        ? { ...mvu.events }
        : {};
    }
    const fn = mvu[method];
    if (typeof fn !== 'function') {
      throw Object.assign(new Error(`mvu.call method unavailable: ${method}`), {
        code: 'method_unavailable',
      });
    }
    return fn.apply(mvu, args);
  }

  /**
   * @param {string} type
   * @param {unknown[]} args
   */
  async function dispatchEvent(type, args) {
    const eventBus = getEventBus();
    const eventName = String(args[0] ?? '');
    const listenerId = args[1] != null ? String(args[1]) : '';

    if (type === 'event.emit') {
      if (!eventBus || typeof eventBus.emit !== 'function') return;
      const emitArgs = args.slice(1);
      return eventBus.emit(eventName, ...emitArgs);
    }

    if (type === 'event.off') {
      const record = listenerRegistry.get(listenerId);
      if (record?.stop) record.stop();
      listenerRegistry.delete(listenerId);
      return;
    }

    if (type === 'event.on' || type === 'event.once') {
      if (!eventBus) return;
      const subscribe =
        type === 'event.once'
          ? eventBus.once?.bind(eventBus) || eventBus.eventOnce?.bind(eventBus)
          : eventBus.on?.bind(eventBus) || eventBus.eventOn?.bind(eventBus);
      if (typeof subscribe !== 'function') return;

      // Capture generation at subscribe time; resolve frame window at fire time
      // so remounts do not post to a detached contentWindow.
      const gen = frameGeneration;
      const handler = (...cbArgs) => {
        if (gen !== frameGeneration) return;
        const liveFrame = getFrameWindow();
        postToFrame(liveFrame, {
          v: BRIDGE_PROTOCOL_VERSION,
          id: `cb_${listenerId}_${Date.now()}`,
          sessionId: getSessionId(),
          type: 'event.cb',
          args: [listenerId, ...cbArgs],
        });
      };
      const sub = subscribe(eventName, handler);
      listenerRegistry.set(listenerId, {
        event: eventName,
        stop:
          sub && typeof sub.stop === 'function'
            ? () => sub.stop()
            : () => {
                eventBus.off?.(eventName, handler);
                eventBus.removeListener?.(eventName, handler);
              },
      });
      return { listenerId };
    }

    return undefined;
  }

  /**
   * @param {string} method
   * @param {unknown[]} args
   */
  function dispatchStorage(method, args) {
    const ns = getStorageNamespace();
    const storage = createScopedLocalStorage(ns);
    if (method === 'getItem') return storage.getItem(String(args[0] ?? ''));
    if (method === 'setItem') {
      storage.setItem(String(args[0] ?? ''), String(args[1] ?? ''));
      return undefined;
    }
    if (method === 'removeItem') {
      storage.removeItem(String(args[0] ?? ''));
      return undefined;
    }
    if (method === 'clear') {
      storage.clear();
      return undefined;
    }
    throw Object.assign(new Error(`storage method unavailable: ${method}`), {
      code: 'method_not_allowed',
    });
  }

  /**
   * @param {object} request
   */
  async function dispatch(request) {
    const type = request.type;
    const method = request.method;
    const args = Array.isArray(request.args) ? request.args : [];

    if (type === 'th.call') return dispatchThCall(method, args);
    if (type === 'mvu.call') return dispatchMvuCall(method, args);
    if (
      type === 'event.on' ||
      type === 'event.off' ||
      type === 'event.once' ||
      type === 'event.emit'
    ) {
      return dispatchEvent(type, args);
    }
    if (type === 'storage') return dispatchStorage(method, args);
    if (type === 'diag' && method === 'log') {
      log('info', 'frame', { args });
      return undefined;
    }
    if (type === 'mount') {
      throw Object.assign(new Error('mount is parent→frame only'), {
        code: 'method_not_allowed',
      });
    }
    if (type === 'event.cb') {
      throw Object.assign(new Error('event.cb is parent→frame only'), {
        code: 'method_not_allowed',
      });
    }
    throw Object.assign(new Error(`unhandled type: ${type}`), {
      code: 'method_not_allowed',
    });
  }

  /**
   * @param {MessageEvent} event
   */
  async function handleMessage(event) {
    if (tornDown) return;
    const data = event.data;
    if (!isBridgeRequest(data)) return;

    // Ignore responses and non-request traffic.
    if (typeof data.ok === 'boolean') return;

    const sessionId = getSessionId();
    if (data.sessionId !== sessionId) {
      // Stale frame from prior session — ignore silently.
      return;
    }

    const frameWin = getFrameWindow();
    if (requireFrameSource) {
      // Reject until a frame is bound (avoids accepting traffic before CardFrame exists).
      if (!frameWin) {
        log('debug', 'reject: no frame window bound', { id: data.id });
        return;
      }
      // Always require source match when bound (including when source is null/falsy).
      if (event.source !== frameWin) {
        log('debug', 'reject: event.source !== frame window', { id: data.id });
        return;
      }
    }

    const validated = validateRequest(data);
    if (!validated.ok) {
      reply(
        event,
        createResponse({
          id: data.id || '',
          ok: false,
          error: validated.error,
        }),
      );
      return;
    }

    try {
      const result = await dispatch(validated.request);
      reply(
        event,
        createResponse({
          id: data.id,
          ok: true,
          result,
        }),
      );
    } catch (error) {
      reply(
        event,
        createResponse({
          id: data.id,
          ok: false,
          error: {
            message: error instanceof Error ? error.message : String(error),
            code: error?.code || 'bridge_error',
          },
        }),
      );
    }
  }

  function start() {
    if (!listenTarget || typeof listenTarget.addEventListener !== 'function') {
      return;
    }
    if (onMessage) return;
    tornDown = false;
    onMessage = (event) => {
      void handleMessage(event);
    };
    listenTarget.addEventListener('message', onMessage);
  }

  function teardown() {
    tornDown = true;
    if (onMessage && listenTarget) {
      try {
        listenTarget.removeEventListener('message', onMessage);
      } catch {
        /* ignore */
      }
    }
    onMessage = null;
    resetFrameListeners();
  }

  /**
   * Push mount message to frame (parent → frame).
   * @param {'setHtml'|'setHeadNodes'} method
   * @param {unknown[]} args
   */
  function sendMount(method, args) {
    const frameWin = getFrameWindow();
    postToFrame(frameWin, {
      v: BRIDGE_PROTOCOL_VERSION,
      id: `mount_${Date.now()}`,
      sessionId: getSessionId(),
      type: 'mount',
      method,
      args: args || [],
    });
  }

  /**
   * @returns {number}
   */
  function getListenerCount() {
    return listenerRegistry.size;
  }

  /**
   * @returns {number}
   */
  function getFrameGeneration() {
    return frameGeneration;
  }

  start();

  return {
    start,
    teardown,
    sendMount,
    resetFrameListeners,
    getListenerCount,
    getFrameGeneration,
    /** @internal test helper */
    _handleMessage: handleMessage,
    _dispatch: dispatch,
  };
}
