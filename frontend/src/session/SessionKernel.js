/**
 * SessionKernel — lifecycle state machine + load/teardown orchestration.
 *
 * Phase machine:
 *
 *   idle
 *     → loading_card          (bootstrap / import / select)
 *     → installing_capabilities  (createRuntime + CapabilityRegistry.install)
 *     → running
 *
 *   running | * → tearing_down → loading_card (next card)
 *                              → idle         (no next)
 *
 *   * → error (lastError set)
 *
 * PR-04 install order (documented):
 *   1. transition installing_capabilities
 *   2. createRuntime — builds runtimeState + TH/Mvu, defines globals via GlobalAdapter,
 *      ContextFactory for SillyTavern.getContext (≠ TavernHelper)
 *   3. hooks.installCapabilities(requirements, runtime) → CapabilityInstallReport
 *      (catalog-driven surface creation is future; today surfaces come from createRuntime)
 *   4. if !report.ok (strict missing required) → fail / block Running
 *   5. running
 *
 * @module session/SessionKernel
 */

/**
 * Allowed phase transitions (from → to[]). Used for soft validation / diagnostics.
 * @type {Record<import('./types.js').SessionPhase, import('./types.js').SessionPhase[]>}
 */
export const SESSION_PHASE_TRANSITIONS = {
  idle: ['loading_card', 'error'],
  loading_card: ['installing_capabilities', 'error', 'tearing_down'],
  installing_capabilities: ['running', 'error', 'tearing_down'],
  running: ['tearing_down', 'error', 'running'],
  tearing_down: ['loading_card', 'idle', 'error'],
  error: ['idle', 'loading_card', 'tearing_down'],
};

/**
 * @typedef {Object} SessionKernelHooks
 * @property {() => void} clearPendingRefreshTimers
 * @property {() => void} cleanupCardArtifacts
 * @property {() => void} [onTeardown]  // e.g. bump tavernHelperRunId, clear UI nodes
 * @property {() => void} renderShell
 * @property {() => void} beginCardArtifactTracking
 * @property {() => void} showOpeningView
 * @property {() => void|Promise<void>} executeTavernHelperScripts
 * @property {(message: string) => void} [showError]
 * @property {(requirements: object|null, runtime: import('./types.js').SessionRuntime) =>
 *   | { ok: boolean, report: object }
 *   | Promise<{ ok: boolean, report: object }>} [installCapabilities]
 */

/**
 * @typedef {Object} CreateSessionKernelOptions
 * @property {import('./SessionStore.js').SessionStore} store
 * @property {{ setDiagnostics?: (text: string|null|undefined) => void }} shell
 * @property {() => import('./types.js').SessionRuntime} createRuntime
 * @property {SessionKernelHooks} hooks
 */

/**
 * Format capability summary for diagnostics strip.
 * @param {object|null|undefined} caps
 * @returns {string}
 */
function formatCapabilitiesSummary(caps) {
  if (!caps || typeof caps !== 'object') return '';
  const byId = caps.byId || {};
  let ready = 0;
  let stub = 0;
  let missing = 0;
  for (const result of Object.values(byId)) {
    if (!result || typeof result !== 'object') continue;
    if (result.status === 'ready') ready += 1;
    else if (result.status === 'stub') stub += 1;
    else if (result.status === 'missing') missing += 1;
  }
  // Prefer explicit arrays when present
  if (Array.isArray(caps.stubs)) stub = caps.stubs.length;
  if (Array.isArray(caps.missing)) missing = caps.missing.length;

  let text = ` | caps: ${ready} ready, ${stub} stub, ${missing} missing`;
  if (Array.isArray(caps.stubs) && caps.stubs.length) {
    const brief = caps.stubs.slice(0, 4).join(',');
    text += ` [${brief}${caps.stubs.length > 4 ? '…' : ''}]`;
  }
  if (Array.isArray(caps.blocking) && caps.blocking.length) {
    text += ` | blocking: ${caps.blocking.join(',')}`;
  }
  return text;
}

/**
 * @param {CreateSessionKernelOptions} options
 */
export function createSessionKernel({ store, shell, createRuntime, hooks }) {
  if (!store) throw new Error('createSessionKernel: store is required');
  if (typeof createRuntime !== 'function') {
    throw new Error('createSessionKernel: createRuntime factory is required');
  }

  const {
    clearPendingRefreshTimers,
    cleanupCardArtifacts,
    onTeardown,
    renderShell,
    beginCardArtifactTracking,
    showOpeningView,
    executeTavernHelperScripts,
    showError,
    installCapabilities,
  } = hooks || {};

  /**
   * Push phase + lastError + capability summary into #st-diagnostics-strip.
   */
  function updateDiagnostics() {
    if (!shell || typeof shell.setDiagnostics !== 'function') return;
    const phase = store.getPhase();
    const card = store.getCardName() || '—';
    const err = store.getLastError();
    const caps = typeof store.getCapabilities === 'function'
      ? store.getCapabilities()
      : store.getSnapshot()?.capabilities;
    const capsText = formatCapabilitiesSummary(caps);
    const text = err
      ? `phase: ${phase} | card: ${card} | error: ${err}${capsText}`
      : `phase: ${phase} | card: ${card}${capsText}`;
    shell.setDiagnostics(text);
  }

  /**
   * @param {import('./types.js').SessionPhase} next
   */
  function transitionTo(next) {
    const from = store.getPhase();
    const allowed = SESSION_PHASE_TRANSITIONS[from];
    if (allowed && !allowed.includes(next) && from !== next) {
      console.warn(`[SessionKernel] unexpected phase transition ${from} → ${next}`);
    }
    store.setPhase(next);
    updateDiagnostics();
  }

  /**
   * Tear down the current session: timers, artifacts, capability globals, runtime null.
   * Phase becomes `tearing_down`, then optionally `idle`.
   *
   * @param {{ toIdle?: boolean }} [options]
   */
  function teardown(options = {}) {
    const { toIdle = false } = options;
    const phase = store.getPhase();
    const runtime = store.getRuntime();
    const hasRuntime = !!runtime;

    if (phase === 'idle' && !hasRuntime && toIdle) {
      updateDiagnostics();
      return;
    }

    if (phase !== 'tearing_down') {
      transitionTo('tearing_down');
    }

    if (typeof clearPendingRefreshTimers === 'function') {
      clearPendingRefreshTimers();
    }
    if (typeof cleanupCardArtifacts === 'function') {
      cleanupCardArtifacts();
    }

    // Uninstall session globals via registry/adapter before dropping runtime.
    try {
      if (runtime?.capabilityRegistry && typeof runtime.capabilityRegistry.teardown === 'function') {
        void runtime.capabilityRegistry.teardown();
      } else if (runtime?.adapter && typeof runtime.adapter.teardown === 'function') {
        runtime.adapter.teardown();
      }
    } catch (error) {
      console.warn('[SessionKernel] capability teardown error:', error);
    }

    store.clearRuntime();
    if (typeof store.setCapabilities === 'function') {
      store.setCapabilities(null);
    }
    if (typeof onTeardown === 'function') {
      onTeardown();
    }

    if (toIdle) {
      transitionTo('idle');
    }
  }

  /**
   * Fail the session: set lastError, clear runtime, phase → error.
   * @param {unknown} error
   * @param {{ showUi?: boolean }} [options]
   */
  function fail(error, options = {}) {
    const { showUi = true } = options;
    const message = error instanceof Error ? error.message : String(error);
    store.setLastError(message);
    const runtime = store.getRuntime();
    try {
      if (runtime?.capabilityRegistry && typeof runtime.capabilityRegistry.teardown === 'function') {
        void runtime.capabilityRegistry.teardown();
      } else if (runtime?.adapter && typeof runtime.adapter.teardown === 'function') {
        runtime.adapter.teardown();
      }
    } catch {
      /* ignore */
    }
    store.clearRuntime();
    transitionTo('error');
    if (showUi && typeof showError === 'function') {
      showError(message);
    }
    return message;
  }

  /**
   * Load a card from backend InitResponse / import / select payload.
   * Orchestrates: teardown previous → loading_card → installing_capabilities
   * (createRuntime + registry.install) → running → shell + opening + TH scripts.
   *
   * @param {import('./types.js').InitResponseData} data
   * @returns {Promise<void>}
   */
  async function loadFromInitResponse(data) {
    try {
      const phase = store.getPhase();
      if (phase !== 'idle' || store.getRuntime()) {
        teardown({ toIdle: false });
      }

      transitionTo('loading_card');
      store.applyInitPayload(data);

      transitionTo('installing_capabilities');

      // 1) createRuntime under installing phase — builds TH/Mvu + adapter globals + ContextFactory
      if (store.getRuntime()) {
        throw new Error('[SessionKernel] runtime must be null before createRuntime');
      }
      const runtime = createRuntime();
      if (!runtime) {
        throw new Error('[SessionKernel] createRuntime returned empty runtime');
      }
      store.setRuntime(runtime);

      // 2) Capability install report (surfaces already on runtime from createRuntime)
      let report = null;
      if (typeof installCapabilities === 'function') {
        const result = await Promise.resolve(
          installCapabilities(store.getRequirements(), runtime)
        );
        report = result?.report ?? result ?? null;
        if (report && typeof store.setCapabilities === 'function') {
          store.setCapabilities(report);
        }
        // Attach registry on runtime for teardown if provided
        if (result?.registry && !runtime.capabilityRegistry) {
          runtime.capabilityRegistry = result.registry;
        }
        updateDiagnostics();

        if (result && result.ok === false) {
          const blocking = (report?.blocking || []).join(', ') || 'required capability';
          throw new Error(
            `[CapabilityRegistry] strict install failed — blocking: ${blocking}`
          );
        }
      } else if (runtime.capabilities && typeof store.setCapabilities === 'function') {
        // createRuntime may attach a pre-built report
        store.setCapabilities(runtime.capabilities);
        report = runtime.capabilities;
        updateDiagnostics();
        if (report.ok === false) {
          const blocking = (report.blocking || []).join(', ') || 'required capability';
          throw new Error(
            `[CapabilityRegistry] strict install failed — blocking: ${blocking}`
          );
        }
      }

      transitionTo('running');

      if (typeof renderShell === 'function') renderShell();
      updateDiagnostics();
      if (typeof beginCardArtifactTracking === 'function') beginCardArtifactTracking();
      if (typeof showOpeningView === 'function') showOpeningView();
      if (typeof executeTavernHelperScripts === 'function') {
        void executeTavernHelperScripts();
      }
    } catch (error) {
      fail(error, { showUi: false });
      throw error;
    }
  }

  /**
   * Read-only runtime accessor. Does **not** create.
   * @returns {import('./types.js').SessionRuntime|null}
   */
  function getRuntime() {
    return store.getRuntime();
  }

  return {
    loadFromInitResponse,
    teardown,
    fail,
    getRuntime,
    getStore: () => store,
    updateDiagnostics,
    transitionTo,
  };
}
