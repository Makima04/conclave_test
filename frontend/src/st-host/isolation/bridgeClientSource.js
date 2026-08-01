/**
 * Bridge client script source injected into the card iframe (PR-09).
 * Exposes TH / MVU / event / storage proxies that RPC to the parent via BridgeProtocol v1.
 *
 * TH method names are generated from BridgeProtocol.TH_CALL_METHODS to avoid drift.
 *
 * updateVariablesWith: function updaters cannot cross postMessage. The client applies
 * them locally after getVariables and commits via replaceVariables.
 *
 * Storage: under opaque sandbox real localStorage throws; we expose
 * `__conclaveBridgeStorage` (async RPC) and a best-effort sync in-memory facade
 * shadowed as `localStorage` where defineProperty allows. Sync parity is limited.
 *
 * Mvu surface: use `window.Mvu` or `window.parentMvu`. Raw `parent.Mvu` is
 * unavailable under opaque sandbox (cross-origin cannot assign onto parent).
 *
 * @module st-host/isolation/bridgeClientSource
 */

import { TH_CALL_METHODS, MVU_CALL_METHODS } from './BridgeProtocol.js';

/**
 * Build the iframe-side bridge client as an IIFE string.
 *
 * @param {{ sessionId: string, parentOrigin?: string }} options
 * @returns {string}
 */
export function buildBridgeClientSource({ sessionId, parentOrigin }) {
  const sid = JSON.stringify(String(sessionId || 'default'));
  const originJson = JSON.stringify(
    parentOrigin && parentOrigin !== 'null' ? String(parentOrigin) : '*',
  );
  // Generate from frozen allowlist so client/host cannot drift (review issue 8).
  const thMethodsJson = JSON.stringify([...TH_CALL_METHODS]);
  // Exclude 'events' from callable wrappers (read via separate populate).
  const mvuCallable = MVU_CALL_METHODS.filter((m) => m !== 'events');
  const mvuMethodsJson = JSON.stringify([...mvuCallable]);

  return `
(function() {
  'use strict';
  var SESSION_ID = ${sid};
  var PARENT_ORIGIN = ${originJson};
  var pending = Object.create(null);
  var seq = 0;
  var cbHandlers = Object.create(null);

  function nextId() {
    seq += 1;
    return 'c' + String(seq) + '_' + String(Date.now());
  }

  function postToParent(msg) {
    try {
      parent.postMessage(msg, PARENT_ORIGIN);
    } catch (err) {
      // Fallback if concrete origin is rejected (e.g. unexpected sandbox mode).
      if (PARENT_ORIGIN !== '*') {
        parent.postMessage(msg, '*');
      } else {
        throw err;
      }
    }
  }

  function rpc(type, method, args) {
    return new Promise(function(resolve, reject) {
      var id = nextId();
      pending[id] = { resolve: resolve, reject: reject };
      var msg = {
        v: 1,
        id: id,
        sessionId: SESSION_ID,
        type: type,
        args: args || []
      };
      if (method !== undefined && method !== null) msg.method = method;
      try {
        postToParent(msg);
      } catch (err) {
        delete pending[id];
        reject(err);
      }
    });
  }

  function rpcCall(type, method) {
    return function() {
      var args = Array.prototype.slice.call(arguments);
      return rpc(type, method, args);
    };
  }

  window.addEventListener('message', function(event) {
    var data = event && event.data;
    if (!data || data.v !== 1 || typeof data.id !== 'string') return;

    // Response to a pending RPC
    if (typeof data.ok === 'boolean' && pending[data.id]) {
      var p = pending[data.id];
      delete pending[data.id];
      if (data.ok) p.resolve(data.result);
      else {
        var err = new Error((data.error && data.error.message) || 'bridge error');
        err.code = (data.error && data.error.code) || 'bridge_error';
        p.reject(err);
      }
      return;
    }

    // Parent → frame: event.cb
    if (data.type === 'event.cb' && data.sessionId === SESSION_ID) {
      var cbArgs = Array.isArray(data.args) ? data.args : [];
      var listenerId = cbArgs[0];
      var rest = cbArgs.slice(1);
      var fn = cbHandlers[listenerId];
      if (typeof fn === 'function') {
        try { fn.apply(null, rest); } catch (e) { console.warn('[conclave:bridge] event.cb error', e); }
      }
      return;
    }

    // Parent → frame: mount.setHtml / mount.setHeadNodes
    if (data.type === 'mount' && data.sessionId === SESSION_ID) {
      try {
        if (data.method === 'setHtml') {
          var html = (data.args && data.args[0]) != null ? String(data.args[0]) : '';
          if (document.body) document.body.innerHTML = html;
        } else if (data.method === 'setHeadNodes') {
          var headHtml = (data.args && data.args[0]) != null ? String(data.args[0]) : '';
          if (document.head) {
            var existing = document.head.querySelectorAll('[data-conclave-card-head="true"]');
            for (var i = 0; i < existing.length; i++) existing[i].remove();
            var tmp = document.createElement('div');
            tmp.innerHTML = headHtml;
            while (tmp.firstChild) {
              var node = tmp.firstChild;
              tmp.removeChild(node);
              if (node.nodeType === 1) {
                try { node.setAttribute('data-conclave-card-head', 'true'); } catch (_) {}
              }
              document.head.appendChild(node);
            }
          }
        }
      } catch (e) {
        console.warn('[conclave:bridge] mount error', e);
      }
    }
  });

  // --- TavernHelper surface (th.call) — names from BridgeProtocol.TH_CALL_METHODS ---
  var thMethods = ${thMethodsJson};
  var TavernHelper = {};
  thMethods.forEach(function(name) {
    // Special-case: function updaters cannot be structured-cloned over postMessage.
    // Apply client-side: getVariables → updater(current) → replaceVariables.
    if (name === 'updateVariablesWith') {
      var updateVariablesWithBridge = function(updater, option) {
        if (typeof updater !== 'function') {
          return Promise.reject(Object.assign(
            new Error(
              'updateVariablesWith over bridge requires a function updater ' +
              '(applied client-side via getVariables + replaceVariables)'
            ),
            { code: 'non_serializable_updater' }
          ));
        }
        var opt = option || { type: 'chat' };
        return rpc('th.call', 'getVariables', [opt]).then(function(current) {
          var result = updater(current);
          function commit(next) {
            return rpc('th.call', 'replaceVariables', [next, opt]).then(function() {
              return next;
            });
          }
          if (result && typeof result.then === 'function') {
            return result.then(commit);
          }
          return commit(result);
        });
      };
      TavernHelper.updateVariablesWith = updateVariablesWithBridge;
      window.updateVariablesWith = updateVariablesWithBridge;
      return;
    }
    var fn = rpcCall('th.call', name);
    TavernHelper[name] = fn;
    window[name] = fn;
  });

  // --- Event API (EventBus is fully exposed under iframe mode — no event-name allowlist) ---
  var listenerSeq = 0;
  function bindEvent(type) {
    return function(eventName, listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('listener must be a function');
      }
      listenerSeq += 1;
      var listenerId = 'L' + String(listenerSeq);
      cbHandlers[listenerId] = listener;
      rpc(type, null, [String(eventName), listenerId]).catch(function(e) {
        console.warn('[conclave:bridge] ' + type + ' failed', e);
      });
      return {
        stop: function() {
          delete cbHandlers[listenerId];
          rpc('event.off', null, [String(eventName), listenerId]).catch(function() {});
        }
      };
    };
  }
  function eventOn(eventName, listener) { return bindEvent('event.on')(eventName, listener); }
  function eventOnce(eventName, listener) { return bindEvent('event.once')(eventName, listener); }
  function eventRemoveListener(eventName, listener) {
    var ids = Object.keys(cbHandlers);
    for (var i = 0; i < ids.length; i++) {
      if (cbHandlers[ids[i]] === listener) {
        delete cbHandlers[ids[i]];
        rpc('event.off', null, [String(eventName), ids[i]]).catch(function() {});
      }
    }
  }
  function eventEmit(eventName) {
    var args = Array.prototype.slice.call(arguments, 1);
    return rpc('event.emit', null, [String(eventName)].concat(args));
  }
  TavernHelper.eventOn = eventOn;
  TavernHelper.eventOnce = eventOnce;
  TavernHelper.eventEmit = eventEmit;
  TavernHelper.eventRemoveListener = eventRemoveListener;
  window.eventOn = eventOn;
  window.eventOnce = eventOnce;
  window.eventEmit = eventEmit;
  window.eventRemoveListener = eventRemoveListener;

  // --- Mvu surface (use window.Mvu / window.parentMvu — not parent.Mvu under opaque sandbox) ---
  var mvuMethods = ${mvuMethodsJson};
  var Mvu = { events: {} };
  mvuMethods.forEach(function(name) {
    if (name === 'isDuringExtraAnalysis') {
      // Prefer sync false for cards that call without await; still RPC for accuracy when awaited.
      Mvu.isDuringExtraAnalysis = function() {
        return false;
      };
      return;
    }
    Mvu[name] = rpcCall('mvu.call', name);
  });
  rpc('mvu.call', 'events', []).then(function(ev) {
    if (ev && typeof ev === 'object') {
      Mvu.events = ev;
    }
  }).catch(function() {});
  window.Mvu = Mvu;
  // Cards should use Mvu / parentMvu — raw parent.Mvu cannot be assigned cross-origin.
  window.parentMvu = Mvu;

  // --- SillyTavern.getContext stub (P2 fields land in PR-10) ---
  window.SillyTavern = {
    getContext: function() {
      return {
        note: 'getContext P2 fields land in PR-10; use TavernHelper / Mvu bridge surface'
      };
    }
  };

  window.TavernHelper = TavernHelper;

  // --- Storage ---
  // Async RPC surface (authoritative, namespaced on parent).
  var bridgeStorage = {
    getItem: function(key) { return rpc('storage', 'getItem', [String(key)]); },
    setItem: function(key, value) { return rpc('storage', 'setItem', [String(key), String(value)]); },
    removeItem: function(key) { return rpc('storage', 'removeItem', [String(key)]); },
    clear: function() { return rpc('storage', 'clear', []); }
  };
  window.__conclaveBridgeStorage = bridgeStorage;

  // Best-effort sync in-memory facade for scripts that expect sync localStorage.
  // Writes fire-and-forget to bridge; reads are local-only until hydrated.
  // Under opaque sandbox, real localStorage throws — we try to shadow it.
  var mem = Object.create(null);
  var syncFacade = {
    get length() { return Object.keys(mem).length; },
    key: function(i) { return Object.keys(mem)[Number(i)] || null; },
    getItem: function(key) {
      var k = String(key);
      return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null;
    },
    setItem: function(key, value) {
      var k = String(key);
      mem[k] = String(value);
      bridgeStorage.setItem(k, mem[k]).catch(function() {});
    },
    removeItem: function(key) {
      var k = String(key);
      delete mem[k];
      bridgeStorage.removeItem(k).catch(function() {});
    },
    clear: function() {
      mem = Object.create(null);
      bridgeStorage.clear().catch(function() {});
    }
  };
  try {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      enumerable: true,
      get: function() { return syncFacade; }
    });
  } catch (_) {
    // defineProperty may fail; scripts can use __conclaveBridgeStorage (async).
    window.__conclaveLocalStorageFacade = syncFacade;
  }

  // --- diag ---
  window.__conclaveBridgeLog = function() {
    var args = Array.prototype.slice.call(arguments);
    return rpc('diag', 'log', args);
  };

  window.__conclaveBridgeReady = true;
  try {
    postToParent({
      v: 1,
      id: nextId(),
      sessionId: SESSION_ID,
      type: 'diag',
      method: 'log',
      args: ['bridge_client_ready']
    });
  } catch (_) {}
})();
`;
}
