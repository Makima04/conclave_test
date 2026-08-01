/**
 * ScriptRunner — unified TavernHelper + inline HTML script lifecycle (PR-08).
 *
 * Same-window execution with abortable runs, storage namespace helpers, and
 * artifact teardown. PR-09 can swap execution adapters without changing call sites.
 *
 * @module st-host/ScriptRunner
 */

const REMOTE_STATIC_IMPORT_RE =
  /(?:^|[\n;])\s*import\s+(?:[^'"\n]+?\s+from\s+)?['"]https?:\/\//im;
const REMOTE_DYNAMIC_IMPORT_RE = /import\s*\(\s*['"]https?:\/\//i;

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
 * Detect remote http(s) module imports in script content or pre-parsed import list.
 *
 * @param {string} [content]
 * @param {string[]} [imports]
 * @returns {boolean}
 */
export function hasRemoteHttpImport(content = '', imports = []) {
  if (Array.isArray(imports) && imports.some(entry => /^https?:\/\//i.test(String(entry || '')))) {
    return true;
  }
  const text = String(content || '');
  if (!text) return false;
  return REMOTE_STATIC_IMPORT_RE.test(text) || REMOTE_DYNAMIC_IMPORT_RE.test(text);
}

/**
 * Feature flag: allow remote TH `import('http…')` (default false).
 * Override via `localStorage['conclave:feature:allow_remote_th_imports'] === '1'`.
 *
 * @param {Storage|null|undefined} [storage]
 * @returns {boolean}
 */
export function isRemoteThImportAllowed(storage) {
  try {
    const store =
      storage ||
      (typeof globalThis !== 'undefined' ? globalThis.localStorage : null);
    return store?.getItem?.('conclave:feature:allow_remote_th_imports') === '1';
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
  /** @type {boolean} */
  let tornDown = false;

  function resolveAllowRemote() {
    if (typeof options.allowRemoteImports === 'function') {
      return !!options.allowRemoteImports();
    }
    if (typeof options.allowRemoteImports === 'boolean') {
      return options.allowRemoteImports;
    }
    return isRemoteThImportAllowed();
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
    return element === root || root.contains(element) || element.contains(root);
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
      try {
        const el = /** @type {Element} */ (node);
        if (typeof el.remove === 'function') {
          el.remove();
        }
      } catch {
        /* ignore */
      }
    });
    artifactNodes.clear();

    if (doc?.querySelectorAll) {
      try {
        doc
          .querySelectorAll(
            '[data-conclave-card-head="true"], script[data-conclave-card-script]',
          )
          .forEach(node => {
            try {
              node.remove();
            } catch {
              /* ignore */
            }
          });
      } catch {
        /* ignore */
      }
    }

    restoreHostDocumentState();
  }

  /**
   * Start MutationObserver tracking of card-injected head/body nodes outside host root.
   */
  function beginCardArtifactTracking() {
    if (!doc?.head || !doc?.body || typeof MutationObserver === 'undefined') {
      return;
    }
    try {
      artifactObserver?.disconnect();
    } catch {
      /* ignore */
    }
    const observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(rememberCardArtifact);
      });
    });
    observer.observe(doc.head, { childList: true });
    observer.observe(doc.body, { childList: true });
    artifactObserver = observer;
    tornDown = false;
  }

  /**
   * Abort pending work and remove all script-owned artifacts.
   * Idempotent: second call is a no-op / no-throw.
   */
  function teardown() {
    abort();
    cleanupArtifacts();
    tornDown = true;
  }

  /**
   * Whether the runner is currently torn down (after teardown, before next run).
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
   * Compatibility prelude for inline module scripts that touch storage.
   *
   * @param {{ content?: string, type?: string }} scriptPart
   * @param {string} namespace
   * @returns {string}
   */
  function cardScriptContentWithCompatibilityPrelude(scriptPart, namespace) {
    const content = scriptPart.content || '';
    if (
      !String(scriptPart.type || '').includes('module') ||
      !/\b(?:localStorage|indexedDB)\b/.test(content)
    ) {
      return content;
    }
    return wrapModuleSourceWithNamespace(content, namespace);
  }

  /**
   * @param {{ content?: string, imports?: string[], name?: string, index?: number }} scriptPart
   * @returns {boolean} true if the script should be executed
   */
  function shouldExecuteScriptPart(scriptPart) {
    if (resolveAllowRemote()) return true;
    if (hasRemoteHttpImport(scriptPart.content, scriptPart.imports)) {
      const label =
        scriptPart.name ||
        `TavernHelper script ${scriptPart.index ?? ''}`.trim() ||
        'script';
      warn(
        '[ScriptRunner] skipped remote http(s) import (set conclave:feature:allow_remote_th_imports=1 to override):',
        label,
      );
      return false;
    }
    return true;
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

    const { runId, signal } = beginTavernHelperRun();

    if (!list.length) {
      return;
    }

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
      if (
        !scriptPart.src &&
        hasRemoteHttpImport(scriptPart.content) &&
        !resolveAllowRemote()
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
