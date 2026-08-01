/**
 * Bridge client script source injected into the card iframe (PR-09).
 * Exposes TH / MVU / event / storage proxies that RPC to the parent via BridgeProtocol v1.
 *
 * @module st-host/isolation/bridgeClientSource
 */

/**
 * Build the iframe-side bridge client as an IIFE string.
 *
 * @param {{ sessionId: string }} options
 * @returns {string}
 */
export function buildBridgeClientSource({ sessionId }) {
  const sid = JSON.stringify(String(sessionId || 'default'));
  return `
(function() {
  'use strict';
  var SESSION_ID = ${sid};
  var pending = Object.create(null);
  var seq = 0;
  var cbHandlers = Object.create(null);

  function nextId() {
    seq += 1;
    return 'c' + String(seq) + '_' + String(Date.now());
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
        parent.postMessage(msg, '*');
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

  // --- TavernHelper surface (th.call) ---
  var thMethods = [
    'getChatMessages', 'setChatMessages', 'setChatMessage', 'getCurrentMessageId',
    'getVariables', 'replaceVariables', 'updateVariablesWith', 'insertOrAssignVariables',
    'insertVariables', 'deleteVariable', 'getLorebookEntries', 'setLorebookEntries',
    'triggerSlash', 'formatAsTavernRegexedString'
  ];
  var TavernHelper = {};
  thMethods.forEach(function(name) {
    var fn = rpcCall('th.call', name);
    TavernHelper[name] = fn;
    window[name] = fn;
  });

  // --- Event API ---
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
    // Best-effort: remove by function identity among local handlers
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

  // --- Mvu surface ---
  var Mvu = {
    getMvuData: rpcCall('mvu.call', 'getMvuData'),
    replaceMvuData: rpcCall('mvu.call', 'replaceMvuData'),
    parseMessage: rpcCall('mvu.call', 'parseMessage'),
    isDuringExtraAnalysis: function() {
      // sync-friendly: cache last known; first call returns promise — cards usually call getMvuData
      return false;
    },
    events: {}
  };
  // Populate events map asynchronously once
  rpc('mvu.call', 'events', []).then(function(ev) {
    if (ev && typeof ev === 'object') {
      Mvu.events = ev;
    }
  }).catch(function() {});
  window.Mvu = Mvu;
  // parent.Mvu facade so cards that read parent.Mvu still hit the bridge surface
  try {
    if (typeof parent !== 'undefined' && parent !== window) {
      // Cannot assign onto real parent when cross-origin; ignore.
    }
  } catch (_) {}
  // Explicit stub for cards that expect a local parent.Mvu shape via our injected name
  window.parentMvu = Mvu;

  // --- SillyTavern.getContext stub note: getContext stays parent-only for P2 PR-10 ---
  window.SillyTavern = {
    getContext: function() {
      return {
        note: 'getContext P2 fields land in PR-10; use TavernHelper / Mvu bridge surface'
      };
    }
  };

  window.TavernHelper = TavernHelper;

  // --- Storage (namespaced on parent) ---
  var bridgeStorage = {
    getItem: function(key) { return rpc('storage', 'getItem', [String(key)]); },
    setItem: function(key, value) { return rpc('storage', 'setItem', [String(key), String(value)]); },
    removeItem: function(key) { return rpc('storage', 'removeItem', [String(key)]); },
    clear: function() { return rpc('storage', 'clear', []); }
  };
  // Prefer bridge storage when opaque origin blocks real localStorage
  try {
    window.__conclaveBridgeStorage = bridgeStorage;
  } catch (_) {}

  // --- diag ---
  window.__conclaveBridgeLog = function() {
    var args = Array.prototype.slice.call(arguments);
    return rpc('diag', 'log', args);
  };

  window.__conclaveBridgeReady = true;
  try {
    parent.postMessage({
      v: 1,
      id: nextId(),
      sessionId: SESSION_ID,
      type: 'diag',
      method: 'log',
      args: ['bridge_client_ready']
    }, '*');
  } catch (_) {}
})();
`;
}
