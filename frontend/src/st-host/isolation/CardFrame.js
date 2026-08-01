/**
 * CardFrame — sandboxed iframe host for card UI (PR-09).
 *
 * Default sandbox: `allow-scripts` only (no allow-same-origin).
 * Storage and TH/MVU/event go through BridgeProtocol; see architecture ADR.
 *
 * Flag `conclave:feature:iframe_same_origin=1` adds allow-same-origin
 * (residual risk: frame can reach parent same-origin DOM/storage).
 *
 * @module st-host/isolation/CardFrame
 */

import { buildBridgeClientSource } from './bridgeClientSource.js';
import { isIframeSameOriginEnabled } from './flags.js';

/**
 * @param {boolean} [allowSameOrigin]
 * @returns {string}
 */
export function resolveSandboxAttribute(allowSameOrigin) {
  const sameOrigin =
    allowSameOrigin === undefined
      ? isIframeSameOriginEnabled()
      : !!allowSameOrigin;
  return sameOrigin ? 'allow-scripts allow-same-origin' : 'allow-scripts';
}

/** Closing script tag fragment (split so source is never a real HTML script closer). */
const SCRIPT_CLOSE = '<' + '/script>';

/**
 * Escape text for embedding inside an HTML context (not attribute).
 * @param {string} text
 * @returns {string}
 */
function escapeScriptClose(text) {
  // Prevent premature </script> termination inside inline scripts.
  return String(text ?? '').replace(/<\/script/gi, '<\\/script');
}

/**
 * @param {{ src?: string, type?: string, content?: string }} scriptPart
 * @returns {string}
 */
function scriptPartToHtml(scriptPart) {
  const typeAttr = scriptPart.type
    ? ` type="${String(scriptPart.type).replace(/"/g, '&quot;')}"`
    : '';
  if (scriptPart.src) {
    const src = String(scriptPart.src).replace(/"/g, '&quot;');
    return `<script${typeAttr} src="${src}" data-conclave-card-script="1">${SCRIPT_CLOSE}`;
  }
  const body = escapeScriptClose(scriptPart.content || '');
  return `<script${typeAttr} data-conclave-card-script="1">${body}${SCRIPT_CLOSE}`;
}

/**
 * @param {{ content?: string, name?: string, index?: number }} scriptPart
 * @param {number} runId
 * @returns {string}
 */
function thScriptToModuleHtml(scriptPart, runId) {
  const label = scriptPart.name || `th-${scriptPart.index ?? runId}`;
  const source = `${scriptPart.content || ''}\n//# sourceURL=conclave-iframe-th-${runId}-${label}.mjs`;
  return `<script type="module" data-conclave-th-script="1">${escapeScriptClose(source)}${SCRIPT_CLOSE}`;
}

/**
 * Build full srcdoc HTML for the card frame.
 *
 * @param {{
 *   sessionId: string,
 *   headHtml?: string,
 *   bodyHtml?: string,
 *   scripts?: Array<{ src?: string, type?: string, content?: string }>,
 *   thScripts?: Array<{ content?: string, name?: string, index?: number }>,
 *   parentOrigin?: string,
 * }} opts
 * @returns {string}
 */
export function buildCardSrcdoc(opts) {
  const sessionId = String(opts.sessionId || 'default');
  const parentOrigin =
    opts.parentOrigin ||
    (typeof globalThis !== 'undefined' && globalThis.location
      ? globalThis.location.origin
      : '*');
  const bridge = buildBridgeClientSource({ sessionId, parentOrigin });
  const headHtml = String(opts.headHtml || '');
  const bodyHtml = String(opts.bodyHtml || '');
  const scripts = Array.isArray(opts.scripts) ? opts.scripts : [];
  const thScripts = Array.isArray(opts.thScripts) ? opts.thScripts : [];
  const runId = Date.now();

  const inlineScripts = scripts.map(scriptPartToHtml).join('\n');
  // Module TH scripts: inject storage alias prelude so localStorage name binds
  // to the bridge facade (sync in-memory + async parent namespace).
  const thHtml = thScripts
    .filter((s) => String(s?.content || '').trim())
    .map((s) => {
      // Prefer shadowed sync facade (or real localStorage under same-origin).
      // Async __conclaveBridgeStorage is fallback only — not sync-compatible.
      const withPrelude = {
        ...s,
        content:
          `const localStorage = window.localStorage || window.__conclaveLocalStorageFacade || window.__conclaveBridgeStorage;\n` +
          `${s.content || ''}`,
      };
      return thScriptToModuleHtml(withPrelude, runId);
    })
    .join('\n');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<script>${escapeScriptClose(bridge)}${SCRIPT_CLOSE}
${headHtml}
</head>
<body>
${bodyHtml}
${inlineScripts}
${thHtml}
</body>
</html>`;
}

/**
 * @typedef {Object} CreateCardFrameOptions
 * @property {HTMLElement} container
 * @property {boolean} [allowSameOrigin]
 * @property {Document} [document]
 * @property {string} [className]
 * @property {string} [title]
 * @property {() => void} [onBeforeSrcdoc]  // e.g. bridgeHost.resetFrameListeners on remount
 * @property {string} [parentOrigin]
 */

/**
 * @param {CreateCardFrameOptions} options
 */
export function createCardFrame(options) {
  if (!options || !options.container) {
    throw new Error('createCardFrame: container is required');
  }

  const doc =
    options.document ||
    (typeof document !== 'undefined' ? document : null);
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error('createCardFrame: document is required');
  }

  const container = options.container;
  const allowSameOrigin = options.allowSameOrigin;
  const sandbox = resolveSandboxAttribute(allowSameOrigin);
  const onBeforeSrcdoc =
    typeof options.onBeforeSrcdoc === 'function' ? options.onBeforeSrcdoc : null;
  const parentOrigin =
    options.parentOrigin ||
    (typeof globalThis !== 'undefined' && globalThis.location
      ? globalThis.location.origin
      : '*');

  /** @type {HTMLIFrameElement} */
  const iframe = doc.createElement('iframe');
  iframe.className = options.className || 'conclave-card-frame';
  iframe.title = options.title || 'Conclave card UI';
  iframe.setAttribute('sandbox', sandbox);
  iframe.setAttribute('data-conclave-card-frame', '1');
  // Fill parent message node
  iframe.style.cssText =
    'border:0;width:100%;min-height:240px;display:block;background:transparent;';

  // Clear container and attach iframe (card CSS stays inside frame).
  container.innerHTML = '';
  container.appendChild(iframe);

  /** @type {{ sessionId: string, headHtml: string, bodyHtml: string, scripts: object[], thScripts: object[], parentOrigin?: string }|null} */
  let lastMount = null;
  let destroyed = false;

  function applySrcdoc(mountState) {
    try {
      onBeforeSrcdoc?.();
    } catch {
      /* ignore */
    }
    iframe.srcdoc = buildCardSrcdoc({
      ...mountState,
      parentOrigin,
    });
  }

  /**
   * @param {{
   *   sessionId: string,
   *   headHtml?: string,
   *   bodyHtml?: string,
   *   scripts?: object[],
   *   thScripts?: object[],
   * }} mountOpts
   */
  function mount(mountOpts) {
    if (destroyed) return;
    lastMount = {
      sessionId: String(mountOpts.sessionId || 'default'),
      headHtml: String(mountOpts.headHtml || ''),
      bodyHtml: String(mountOpts.bodyHtml || ''),
      scripts: Array.isArray(mountOpts.scripts) ? mountOpts.scripts : [],
      thScripts: Array.isArray(mountOpts.thScripts)
        ? mountOpts.thScripts
        : lastMount?.thScripts || [],
    };
    applySrcdoc(lastMount);
  }

  /**
   * Update TH scripts and rebuild srcdoc (keeps last HTML/scripts).
   * @param {Array<{ content?: string, name?: string, index?: number }>} thScripts
   */
  function setTavernHelperScripts(thScripts) {
    if (destroyed || !lastMount) {
      lastMount = {
        sessionId: 'default',
        headHtml: '',
        bodyHtml: '',
        scripts: [],
        thScripts: Array.isArray(thScripts) ? thScripts : [],
      };
    } else {
      lastMount.thScripts = Array.isArray(thScripts) ? thScripts : [];
    }
    applySrcdoc(lastMount);
  }

  /**
   * @returns {Window|null}
   */
  function getContentWindow() {
    if (destroyed) return null;
    try {
      return iframe.contentWindow || null;
    } catch {
      // Sandbox without allow-same-origin may throw or return restricted window.
      return iframe.contentWindow || null;
    }
  }

  /**
   * @returns {HTMLIFrameElement|null}
   */
  function getIframe() {
    return destroyed ? null : iframe;
  }

  /**
   * @returns {HTMLElement}
   */
  function getContainer() {
    return container;
  }

  /**
   * @returns {string}
   */
  function getSandbox() {
    return sandbox;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    lastMount = null;
    try {
      iframe.removeAttribute('srcdoc');
      iframe.src = 'about:blank';
    } catch {
      /* ignore */
    }
    try {
      iframe.remove();
    } catch {
      /* ignore */
    }
  }

  return {
    mount,
    setTavernHelperScripts,
    getContentWindow,
    getIframe,
    getContainer,
    getSandbox,
    destroy,
  };
}
