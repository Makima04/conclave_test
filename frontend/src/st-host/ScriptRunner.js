/**
 * ScriptRunner — unified TavernHelper + inline HTML script lifecycle (PR-08).
 *
 * Same-window execution with abortable runs, storage namespace helpers, and
 * artifact teardown. PR-09 can swap execution adapters without changing call sites.
 *
 * @module st-host/ScriptRunner
 */

/**
 * Remote module URL detector (default-deny for same-window TH / card scripts).
 * Multiline-safe: `from 'https://…'`, protocol-relative `//cdn…`, dynamic import(),
 * and side-effect / export-from forms. Does not require a single-line `import … from`.
 */
const REMOTE_MODULE_URL_RE = /(?:https?:)?\/\//i;
/** `from 'https://…'` / `from '//…'` — covers multi-line named imports and `export … from`. */
const REMOTE_FROM_RE = /\bfrom\s*['"](?:https?:)?\/\//i;
/** Side-effect `import 'https://…'` / `import '//…'`. */
const REMOTE_BARE_IMPORT_RE = /(?:^|[\n;])\s*import\s*['"](?:https?:)?\/\//im;
/** Dynamic `import('https://…')` / `import('//…')`. */
const REMOTE_DYNAMIC_IMPORT_RE = /import\s*\(\s*['"](?:https?:)?\/\//i;

/**
 * True when a script src / import specifier is a remote http(s) or protocol-relative URL.
 * @param {string} [spec]
 * @returns {boolean}
 */
export function isRemoteScriptUrl(spec) {
  const s = String(spec || '').trim();
  if (!s) return false;
  return /^(?:https?:)?\/\//i.test(s);
}

/**
 * Build scoped storage namespace for a session + card import id.
 * Shape: `conclave:session:{sessionId}:card:{importId}:`
 *
 * @param {{ sessionId?: string|number|null, importId?: string|number|null }} [parts]
 * @returns {string}
 */
export function buildStorageNamespace(parts = {}) {
  const sessionId =
    parts.sessionId == null || parts.sessionId === ''
      ? 'default'
      : String(parts.sessionId);
  const importId =
    parts.importId == null || parts.importId === ''
      ? 'current'
      : String(parts.importId);
  return `conclave:session:${sessionId}:card:${importId}:`;
}

/**
 * Detect remote http(s) / protocol-relative module imports in script content
 * or a pre-parsed import specifier list (backend `imports[]`).
 *
 * @param {string} [content]
 * @param {string[]} [imports]
 * @returns {boolean}
 */
export function hasRemoteHttpImport(content = '', imports = []) {
  if (Array.isArray(imports) && imports.some(entry => isRemoteScriptUrl(entry))) {
    return true;
  }
  const text = String(content || '');
  if (!text) return false;
  // Cheap filter: no URL-looking token at all.
  if (!REMOTE_MODULE_URL_RE.test(text)) return false;
  return (
    REMOTE_FROM_RE.test(text) ||
    REMOTE_BARE_IMPORT_RE.test(text) ||
    REMOTE_DYNAMIC_IMPORT_RE.test(text)
  );
}

/**
 * Known CDN hosts used by popular Chinese card TH packs (cangxuan statusbar,
 * MagVarUpdate, StageDog mvu_zod, etc.). Default-allow only these hosts so
 * 灵机-class UIs work without open-ended remote RCE.
 *
 * Override:
 * - `localStorage['conclave:feature:allow_remote_th_imports'] === '1'` → allow all remote
 * - `=== '0'` → deny all remote (including allowlist)
 * - unset → allow allowlisted hosts only
 */
export const TH_REMOTE_ALLOWLIST_HOSTS = Object.freeze([
  'testingcf.jsdelivr.net',
  'cdn.jsdelivr.net',
  'fastly.jsdelivr.net',
  'gcore.jsdelivr.net',
  'cdn.jsdmirror.com',
  'unpkg.com',
  'cdnjs.cloudflare.com',
]);

/**
 * @param {string} [spec] import URL or content snippet host check
 * @param {readonly string[]} [hosts]
 * @returns {boolean}
 */
export function isAllowlistedRemoteUrl(spec, hosts = TH_REMOTE_ALLOWLIST_HOSTS) {
  const s = String(spec || '').trim();
  if (!s) return false;
  try {
    const withProto = s.startsWith('//') ? `https:${s}` : s;
    if (!/^https?:\/\//i.test(withProto)) return false;
    const u = new URL(withProto);
    const host = u.hostname.toLowerCase();
    return hosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * True when every remote import specifier in content/imports is allowlisted.
 * Non-remote scripts return true.
 *
 * @param {string} [content]
 * @param {string[]} [imports]
 * @param {readonly string[]} [hosts]
 * @returns {boolean}
 */
export function allRemoteImportsAllowlisted(content = '', imports = [], hosts = TH_REMOTE_ALLOWLIST_HOSTS) {
  const specs = [];
  if (Array.isArray(imports)) {
    for (const entry of imports) {
      if (isRemoteScriptUrl(entry)) specs.push(String(entry));
    }
  }
  const text = String(content || '');
  if (text) {
    const re =
      /(?:from\s*|import\s*\(\s*|import\s+)['"]((?:https?:)?\/\/[^'"]+)['"]/gi;
    let m;
    while ((m = re.exec(text))) {
      specs.push(m[1]);
    }
  }
  if (!specs.length) return true;
  return specs.every((spec) => isAllowlistedRemoteUrl(spec, hosts));
}

/**
 * Feature policy for remote TH imports.
 *
 * - flag `'1'` → allow all remote
 * - flag `'0'` → deny all remote
 * - unset → allow only {@link TH_REMOTE_ALLOWLIST_HOSTS} (default for 灵机)
 *
 * For callers that only check a boolean "open remote?", prefer
 * {@link isRemoteThImportAllowedForScript} when script content is known.
 *
 * @param {Storage|null|undefined} [storage]
 * @returns {boolean} true when *any* remote may be considered (flag 1 or allowlist mode)
 */
export function isRemoteThImportAllowed(storage) {
  try {
    const store =
      storage ||
      (typeof globalThis !== 'undefined' ? globalThis.localStorage : null);
    const flag = store?.getItem?.('conclave:feature:allow_remote_th_imports');
    if (flag === '0') return false;
    if (flag === '1') return true;
    // Default: allowlist mode (not fully open).
    return true;
  } catch {
    return true;
  }
}

/**
 * Whether a specific script part may load remote modules.
 *
 * @param {{ content?: string, imports?: string[] }} scriptPart
 * @param {Storage|null|undefined} [storage]
 * @returns {boolean}
 */
export function isRemoteThImportAllowedForScript(scriptPart, storage) {
  try {
    const store =
      storage ||
      (typeof globalThis !== 'undefined' ? globalThis.localStorage : null);
    const flag = store?.getItem?.('conclave:feature:allow_remote_th_imports');
    if (flag === '0') return false;
    if (flag === '1') return true;
    return allRemoteImportsAllowlisted(
      scriptPart?.content,
      scriptPart?.imports,
    );
  } catch {
    return false;
  }
}

/**
 * @typedef {Object} ScriptRunnerHostBaseline
 * @property {string} [htmlClassName]
 * @property {string|null} [htmlStyle]
 * @property {string} [bodyClassName]
 * @property {string|null} [bodyStyle]
 */

/**
 * @typedef {Object} CreateScriptRunnerOptions
 * @property {Document} [document]
 * @property {() => (Element|null|undefined)} [getHostRoot]
 * @property {ScriptRunnerHostBaseline} [hostBaseline]
 * @property {boolean|(() => boolean)} [allowRemoteImports]
 * @property {(url: string) => Promise<unknown>} [importModule]
 * @property {(blob: Blob) => string} [createObjectURL]
 * @property {(url: string) => void} [revokeObjectURL]
 * @property {(msg?: string, ...args: unknown[]) => void} [warn]
 * @property {(msg?: string, ...args: unknown[]) => void} [debug]
 */

/**
 * @param {CreateScriptRunnerOptions} [options]
 */
export function createScriptRunner(options = {}) {
  const doc =
    options.document ||
    (typeof document !== 'undefined' ? document : null);
  const getHostRoot =
    typeof options.getHostRoot === 'function' ? options.getHostRoot : () => null;
  const hostBaseline = options.hostBaseline || {
    htmlClassName: '',
    htmlStyle: null,
    bodyClassName: '',
    bodyStyle: null,
  };
  const warn = options.warn || ((...args) => console.warn(...args));
  const debug = options.debug || ((...args) => console.debug(...args));

  const importModule =
    typeof options.importModule === 'function'
      ? options.importModule
      : url => import(/* @vite-ignore */ url);

  const createObjectURL =
    typeof options.createObjectURL === 'function'
      ? options.createObjectURL
      : blob => URL.createObjectURL(blob);

  const revokeObjectURL =
    typeof options.revokeObjectURL === 'function'
      ? options.revokeObjectURL
      : url => URL.revokeObjectURL(url);

  /** @type {number} */
  let tavernHelperRunId = 0;
  /** @type {number} */
  let scriptRunId = 0;
  /** @type {AbortController|null} */
  let activeController = null;
  /** @type {MutationObserver|null} */
  let artifactObserver = null;
  /** @type {Set<Node>} */
  const artifactNodes = new Set();
  /**
   * Direct children of documentElement/head/body present when tracking started.
   * Used to sweep card-injected siblings (e.g. 静浦 `#st-social-phone` on `<html>`).
   * @type {Set<Node>}
   */
  let hostDomBaseline = new Set();
  /** @type {boolean} */
  let tornDown = false;

  /**
   * Known sticky selectors that card TH scripts mount outside the chat root.
   * Shared across cards — cleanup must always remove these on switch.
   */
  const STICKY_CARD_UI_SELECTORS = [
    '#st-social-phone',
    '[id="st-social-phone"]',
  ];

  /**
   * Full-open remote policy (flag '1' or host option). Allowlist-only mode
   * returns false — callers must use per-URL checks via allowRemoteSrc /
   * isRemoteThImportAllowedForScript.
   */
  function resolveAllowRemote() {
    if (typeof options.allowRemoteImports === 'function') {
      return !!options.allowRemoteImports();
    }
    if (typeof options.allowRemoteImports === 'boolean') {
      return !!options.allowRemoteImports;
    }
    try {
      const store =
        typeof globalThis !== 'undefined' ? globalThis.localStorage : null;
      return store?.getItem?.('conclave:feature:allow_remote_th_imports') === '1';
    } catch {
      return false;
    }
  }

  /** @param {string} [src] */
  function allowRemoteSrc(src) {
    if (resolveAllowRemote()) return true;
    try {
      const store =
        typeof globalThis !== 'undefined' ? globalThis.localStorage : null;
      if (store?.getItem?.('conclave:feature:allow_remote_th_imports') === '0') {
        return false;
      }
    } catch {
      /* ignore */
    }
    return isAllowlistedRemoteUrl(src);
  }

  /**
   * @returns {number}
   */
  function getTavernHelperRunId() {
    return tavernHelperRunId;
  }

  /**
   * @returns {number}
   */
  function getScriptRunId() {
    return scriptRunId;
  }

  /**
   * @returns {AbortSignal|null}
   */
  function getSignal() {
    return activeController?.signal ?? null;
  }

  /**
   * Cancel pending async script work (TH import loops) and invalidate run ids.
   * Safe to call repeatedly.
   */
  function abort() {
    if (activeController) {
      try {
        activeController.abort();
      } catch {
        /* ignore */
      }
      activeController = null;
    }
    // Invalidate any in-flight loops that snapshot run ids.
    tavernHelperRunId += 1;
    scriptRunId += 1;
  }

  /**
   * Start a new TavernHelper generation (aborts prior TH work only).
   * Inline HTML script runs use a separate counter so message re-renders
   * do not cancel in-flight TH imports.
   * @returns {{ runId: number, signal: AbortSignal }}
   */
  function beginTavernHelperRun() {
    if (activeController) {
      try {
        activeController.abort();
      } catch {
        /* ignore */
      }
      activeController = null;
    }
    tavernHelperRunId += 1;
    tornDown = false;
    activeController = new AbortController();
    return { runId: tavernHelperRunId, signal: activeController.signal };
  }

  /**
   * Start a new inline HTML script generation (does not abort TH).
   * @returns {number}
   */
  function beginInlineRun() {
    scriptRunId += 1;
    tornDown = false;
    return scriptRunId;
  }

  /**
   * @param {Node} node
   * @returns {boolean}
   */
  function isInsideHostRoot(node) {
    const root = getHostRoot();
    if (!root || !node || node.nodeType !== 1 /* ELEMENT_NODE */) return false;
    const element = /** @type {Element} */ (node);
    if (element === root) return true;
    try {
      if (typeof root.contains === 'function' && root.contains(element)) return true;
    } catch {
      /* ignore */
    }
    try {
      if (typeof element.contains === 'function' && element.contains(root)) return true;
    } catch {
      /* ignore */
    }
    return false;
  }

  /**
   * @param {Node} node
   */
  function rememberCardArtifact(node) {
    if (!node || node.nodeType !== 1 || isInsideHostRoot(node)) return;
    artifactNodes.add(node);
  }

  function restoreElementAttribute(element, name, value) {
    if (!element) return;
    if (value === null || value === undefined || value === '') {
      element.removeAttribute(name);
    } else {
      element.setAttribute(name, value);
    }
  }

  function restoreHostDocumentState() {
    if (!doc?.documentElement || !doc?.body) return;
    doc.documentElement.className = hostBaseline.htmlClassName || '';
    restoreElementAttribute(
      doc.documentElement,
      'style',
      hostBaseline.htmlStyle,
    );
    doc.body.className = hostBaseline.bodyClassName || '';
    restoreElementAttribute(doc.body, 'style', hostBaseline.bodyStyle);
  }

  /**
   * Snapshot direct children of html/head/body so cleanup can remove later injects
   * even if MutationObserver missed them (timing / wrong parent).
   */
  function captureHostDomBaseline() {
    /** @type {Set<Node>} */
    const baseline = new Set();
    const roots = [doc?.documentElement, doc?.head, doc?.body].filter(Boolean);
    for (const root of roots) {
      const children = root.childNodes;
      if (!children) continue;
      for (let i = 0; i < children.length; i += 1) {
        baseline.add(children[i]);
      }
    }
    hostDomBaseline = baseline;
  }

  /**
   * Remove a node if it is an element and not inside the chat host root.
   * @param {Node|null|undefined} node
   */
  function removeIfCardArtifact(node) {
    if (!node || node.nodeType !== 1 /* ELEMENT_NODE */) return;
    if (isInsideHostRoot(node)) return;
    try {
      const el = /** @type {Element} */ (node);
      if (typeof el.remove === 'function') {
        el.remove();
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Sweep sticky card UIs + any non-baseline direct children of html/head/body.
   * Covers 静浦「小手机」which mounts on documentElement (not body), which the
   * original head/body-only observer never saw.
   */
  function sweepUntrackedCardDom() {
    if (!doc) return;

    if (typeof doc.querySelectorAll === 'function') {
      try {
        for (const sel of STICKY_CARD_UI_SELECTORS) {
          doc.querySelectorAll(sel).forEach(node => {
            removeIfCardArtifact(node);
          });
        }
        doc
          .querySelectorAll(
            '[data-conclave-card-head="true"], script[data-conclave-card-script]',
          )
          .forEach(node => {
            removeIfCardArtifact(node);
          });
      } catch {
        /* ignore */
      }
    }

    const containers = [doc.documentElement, doc.head, doc.body].filter(Boolean);
    for (const container of containers) {
      // Snapshot to array — live NodeList mutates while we remove.
      const kids = Array.from(container.childNodes || []);
      for (const child of kids) {
        if (hostDomBaseline.has(child)) continue;
        // Never remove the structural head/body elements themselves.
        if (child === doc.head || child === doc.body) continue;
        if (child.nodeType !== 1) continue;
        const tag = /** @type {Element} */ (child).tagName;
        if (tag === 'HEAD' || tag === 'BODY') continue;
        removeIfCardArtifact(child);
      }
    }
  }

  /**
   * Disconnect observer and remove script/card artifact nodes; restore host document.
   * Does not abort runs by itself (use teardown()).
   */
  function cleanupArtifacts() {
    try {
      artifactObserver?.disconnect();
    } catch {
      /* ignore */
    }
    artifactObserver = null;

    artifactNodes.forEach(node => {
      removeIfCardArtifact(node);
    });
    artifactNodes.clear();

    sweepUntrackedCardDom();
    restoreHostDocumentState();
  }

  /**
   * Start MutationObserver tracking of card-injected nodes outside host root.
   * Observes documentElement + head + body: TH scripts (静浦小手机) often append
   * to documentElement, which a body-only observer would miss.
   *
   * Baseline is captured even when MutationObserver is unavailable (node tests)
   * so cleanup can still sweep sticky selectors + non-baseline siblings.
   */
  function beginCardArtifactTracking() {
    if (!doc?.head || !doc?.body) {
      return;
    }
    try {
      artifactObserver?.disconnect();
    } catch {
      /* ignore */
    }
    artifactObserver = null;
    captureHostDomBaseline();
    tornDown = false;

    if (typeof MutationObserver === 'undefined') {
      return;
    }
    const observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(rememberCardArtifact);
      });
    });
    // documentElement catches siblings of head/body (fixed phone shells, etc.).
    if (doc.documentElement) {
      observer.observe(doc.documentElement, { childList: true });
    }
    observer.observe(doc.head, { childList: true });
    observer.observe(doc.body, { childList: true });
    artifactObserver = observer;
  }

  /**
   * Abort pending work and remove all script-owned artifacts.
   * Safe to call repeatedly (no-throw). Each call re-aborts / re-bumps run ids
   * and re-runs cleanup — not a pure no-op, but always safe.
   *
   * Same-window limit: an already-evaluating `import()` body cannot be hard-killed;
   * late DOM mutations after observer disconnect may need the next card's cleanup
   * or PR-09 iframe isolation. Optional microtask re-sweep helps catch stragglers.
   */
  function teardown() {
    abort();
    cleanupArtifacts();
    tornDown = true;
    // Soft mitigation: re-sweep after abort in case an in-flight module
    // appended nodes between abort and observer disconnect (common with TH
    // 小手机 fixed shells). Microtask + short timer catch both sync and
    // promise-then appends. Skip if beginCardArtifactTracking already ran
    // for the next card (tornDown=false) so we do not kill the new card's UI.
    const resweep = () => {
      if (!tornDown) return;
      try {
        sweepUntrackedCardDom();
        artifactNodes.forEach(node => {
          removeIfCardArtifact(node);
        });
        artifactNodes.clear();
      } catch {
        /* ignore */
      }
    };
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(resweep);
    }
    if (typeof setTimeout === 'function') {
      setTimeout(resweep, 0);
      setTimeout(resweep, 50);
    }
  }

  /**
   * True after `teardown()` until the next beginTavernHelperRun / beginInlineRun /
   * beginCardArtifactTracking. Production main.js often uses abort+cleanupArtifacts
   * separately (without setting this flag).
   * @returns {boolean}
   */
  function isTornDown() {
    return tornDown;
  }

  /**
   * Build module prelude that scopes localStorage / indexedDB / BroadcastChannel.
   *
   * @param {string} content
   * @param {string} namespace
   * @returns {string}
   */
  function wrapModuleSourceWithNamespace(content, namespace) {
    const ns = JSON.stringify(namespace);
    return `
    const localStorage = window.__conclaveCreateScopedLocalStorage(${ns});
    const indexedDB = window.__conclaveCreateScopedIndexedDB(${ns});
    const BroadcastChannel = window.BroadcastChannel
      ? class ConclaveScopedBroadcastChannel extends window.BroadcastChannel {
        constructor(name) {
          super(${ns} + 'BroadcastChannel:' + String(name));
        }
      }
      : undefined;
    ${content}
  `;
  }

  /**
   * When the host page is already past `loading`, card scripts that only register
   * `DOMContentLoaded` never run their init (e.g. 变身少女「状态栏美化」). For the
   * duration of a sync classic script, fire those listeners on the next microtask.
   *
   * @param {string} content
   * @returns {string}
   */
  function wrapClassicScriptWithDomReadyShim(content) {
    const src = String(content || '');
    if (!/\bDOMContentLoaded\b/.test(src)) return src;
    return `
(function(){
  var __conclaveDocReady = typeof document !== 'undefined' && document.readyState !== 'loading';
  var __conclaveOrigAdd = document.addEventListener.bind(document);
  document.addEventListener = function(type, listener, options) {
    if (__conclaveDocReady && type === 'DOMContentLoaded' && typeof listener === 'function') {
      try {
        if (typeof queueMicrotask === 'function') queueMicrotask(function(){ listener.call(document); });
        else setTimeout(function(){ listener.call(document); }, 0);
      } catch (e) { console.warn('[ScriptRunner] DOMContentLoaded shim', e); }
      return;
    }
    return __conclaveOrigAdd(type, listener, options);
  };
  try {
${src}
  } finally {
    document.addEventListener = __conclaveOrigAdd;
  }
})();
`;
  }

  /**
   * Compatibility prelude for inline module scripts that touch storage,
   * plus classic-script DOMContentLoaded shim when the page is already loaded.
   *
   * @param {{ content?: string, type?: string }} scriptPart
   * @param {string} namespace
   * @returns {string}
   */
  function cardScriptContentWithCompatibilityPrelude(scriptPart, namespace) {
    let content = scriptPart.content || '';
    const type = String(scriptPart.type || '');
    const isModule = type.includes('module');

    if (isModule && /\b(?:localStorage|indexedDB)\b/.test(content)) {
      content = wrapModuleSourceWithNamespace(content, namespace);
    } else if (!isModule) {
      content = wrapClassicScriptWithDomReadyShim(content);
    }
    return content;
  }

  /**
   * @param {{ content?: string, imports?: string[], name?: string, index?: number }} scriptPart
   * @returns {boolean} true if the script should be executed
   */
  function shouldExecuteScriptPart(scriptPart) {
    if (!hasRemoteHttpImport(scriptPart.content, scriptPart.imports)) {
      return true;
    }
    // Host option true / function true → allow any remote.
    if (options.allowRemoteImports === true) return true;
    if (typeof options.allowRemoteImports === 'function' && options.allowRemoteImports()) {
      return true;
    }
    // Default: flag '1' all, '0' none, unset allowlist-only.
    if (isRemoteThImportAllowedForScript(scriptPart)) return true;

    const label =
      scriptPart.name ||
      `TavernHelper script ${scriptPart.index ?? ''}`.trim() ||
      'script';
    warn(
      '[ScriptRunner] skipped remote http(s) import (allowlist or set conclave:feature:allow_remote_th_imports=1):',
      label,
    );
    return false;
  }

  /**
   * Execute TavernHelper scripts via blob module import (abortable).
   *
   * @param {Array<{ content?: string, imports?: string[], name?: string, index?: number }>} scripts
   * @param {{
   *   ensureRuntime?: () => unknown,
   *   onComplete?: (runtime: unknown, runId: number) => void|Promise<void>,
   *   getRuntime?: () => unknown,
   * }} [opts]
   * @returns {Promise<void>}
   */
  async function runTavernHelper(scripts, opts = {}) {
    const list = (Array.isArray(scripts) ? scripts : []).filter(script =>
      String(script?.content || '').trim(),
    );

    // Empty list: invalidate prior TH work without allocating a live controller.
    if (!list.length) {
      if (activeController) {
        try {
          activeController.abort();
        } catch {
          /* ignore */
        }
        activeController = null;
      }
      tavernHelperRunId += 1;
      return;
    }

    const { runId, signal } = beginTavernHelperRun();

    if (typeof opts.ensureRuntime === 'function') {
      opts.ensureRuntime();
    }

    for (const scriptPart of list) {
      if (signal.aborted || runId !== tavernHelperRunId) return;
      if (!shouldExecuteScriptPart(scriptPart)) continue;

      const label =
        scriptPart.name || `TavernHelper script ${scriptPart.index ?? ''}`;
      const source = `${scriptPart.content}\n//# sourceURL=conclave-tavern-helper-${runId}-${scriptPart.index ?? 'script'}.mjs`;
      let url = '';
      try {
        url = createObjectURL(new Blob([source], { type: 'text/javascript' }));
        if (signal.aborted || runId !== tavernHelperRunId) return;
        await importModule(url);
        if (signal.aborted || runId !== tavernHelperRunId) return;
        debug('[ScriptRunner] TavernHelper script loaded:', label);
      } catch (error) {
        if (signal.aborted || runId !== tavernHelperRunId) return;
        warn('[ScriptRunner] TavernHelper script failed:', label, error);
      } finally {
        if (url) {
          try {
            revokeObjectURL(url);
          } catch {
            /* ignore */
          }
        }
      }
    }

    if (signal.aborted || runId !== tavernHelperRunId) return;

    if (typeof opts.onComplete === 'function') {
      const runtime =
        typeof opts.getRuntime === 'function' ? opts.getRuntime() : undefined;
      await opts.onComplete(runtime, runId);
    }
  }

  /**
   * Inject inline / external card HTML scripts into the document body.
   *
   * Remote policy (same feature flag as TH module imports):
   * - Inline *content* with remote `import` / `from 'https://…'` → skipped by default
   * - Classic `<script src="https://…">` / protocol-relative src → also skipped by default
   *   (jquery src still skipped via skipSrcPattern regardless of flag)
   *
   * @param {Array<{ src?: string, type?: string, content?: string }>} scripts
   * @param {{ namespace?: string, skipSrcPattern?: RegExp }} [opts]
   */
  function runInlineHtmlScripts(scripts, opts = {}) {
    if (!doc?.body || typeof doc.createElement !== 'function') return;

    const runId = beginInlineRun();
    const namespace = opts.namespace || buildStorageNamespace();
    const skipSrc =
      opts.skipSrcPattern instanceof RegExp ? opts.skipSrcPattern : /jquery/i;
    const list = Array.isArray(scripts) ? scripts : [];

    list.forEach(scriptPart => {
      if (runId !== scriptRunId) return;
      if (scriptPart.src && skipSrc.test(scriptPart.src)) return;

      // Classic external script tags: allowlist or full-open flag.
      if (scriptPart.src && isRemoteScriptUrl(scriptPart.src) && !allowRemoteSrc(scriptPart.src)) {
        warn(
          '[ScriptRunner] skipped remote script src (allowlist or set conclave:feature:allow_remote_th_imports=1):',
          scriptPart.src,
        );
        return;
      }

      if (
        !scriptPart.src &&
        hasRemoteHttpImport(scriptPart.content) &&
        !shouldExecuteScriptPart({
          content: scriptPart.content,
          name: scriptPart.src || 'inline',
        })
      ) {
        warn(
          '[ScriptRunner] skipped inline script with remote http(s) import',
        );
        return;
      }

      const script = doc.createElement('script');
      if (script.dataset) {
        script.dataset.conclaveCardScript = String(runId);
      } else {
        script.setAttribute?.('data-conclave-card-script', String(runId));
      }
      if (scriptPart.type) script.type = scriptPart.type;
      if (scriptPart.src) {
        script.src = scriptPart.src;
      } else {
        script.textContent = cardScriptContentWithCompatibilityPrelude(
          scriptPart,
          namespace,
        );
      }
      doc.body.appendChild(script);
      rememberCardArtifact(script);
    });
  }

  return {
    abort,
    teardown,
    cleanupArtifacts,
    beginCardArtifactTracking,
    restoreHostDocumentState,
    runTavernHelper,
    runInlineHtmlScripts,
    buildStorageNamespace,
    cardScriptContentWithCompatibilityPrelude,
    wrapModuleSourceWithNamespace,
    hasRemoteHttpImport,
    shouldExecuteScriptPart,
    getTavernHelperRunId,
    getScriptRunId,
    getSignal,
    isTornDown,
    rememberCardArtifact,
  };
}
