/**
 * SessionStore — single source of truth for session snapshot fields.
 * @module session/SessionStore
 */

/**
 * @returns {import('./types.js').SessionSnapshot}
 */
function createEmptySnapshot() {
  return {
    phase: 'idle',
    lastError: null,
    cardName: '',
    currentWorldbookId: null,
    worldbookEntries: [],
    tavernHelperScripts: [],
    importedWorldbooks: [],
    openingRawMessages: [''],
    openingRenderedMessages: [''],
    requirements: null,
    runtime: null,
    capabilities: null,
  };
}

/**
 * Create a mutable SessionStore holding the live SessionSnapshot.
 * @returns {SessionStore}
 */
export function createSessionStore() {
  /** @type {import('./types.js').SessionSnapshot} */
  let snapshot = createEmptySnapshot();

  /**
   * @returns {import('./types.js').SessionSnapshot}
   */
  function getSnapshot() {
    return snapshot;
  }

  /** @returns {import('./types.js').SessionPhase} */
  function getPhase() {
    return snapshot.phase;
  }

  /**
   * @param {import('./types.js').SessionPhase} phase
   */
  function setPhase(phase) {
    snapshot.phase = phase;
  }

  /** @returns {string|null} */
  function getLastError() {
    return snapshot.lastError;
  }

  /**
   * @param {string|null} error
   */
  function setLastError(error) {
    snapshot.lastError = error == null || error === '' ? null : String(error);
  }

  /** @returns {string} */
  function getCardName() {
    return snapshot.cardName;
  }

  /** @returns {number|null} */
  function getCurrentWorldbookId() {
    return snapshot.currentWorldbookId;
  }

  /** @returns {Array<object>} */
  function getWorldbookEntries() {
    return snapshot.worldbookEntries;
  }

  /** @returns {Array<object>} */
  function getTavernHelperScripts() {
    return snapshot.tavernHelperScripts;
  }

  /** @returns {Array<object>} */
  function getImportedWorldbooks() {
    return snapshot.importedWorldbooks;
  }

  /** @returns {string[]} */
  function getOpeningRawMessages() {
    return snapshot.openingRawMessages;
  }

  /** @returns {string[]} */
  function getOpeningRenderedMessages() {
    return snapshot.openingRenderedMessages;
  }

  /** @returns {object|null} */
  function getRequirements() {
    return snapshot.requirements;
  }

  /** @returns {import('./types.js').SessionRuntime|null} */
  function getRuntime() {
    return snapshot.runtime;
  }

  /**
   * @param {import('./types.js').SessionRuntime|null} runtime
   */
  function setRuntime(runtime) {
    snapshot.runtime = runtime;
  }

  function clearRuntime() {
    snapshot.runtime = null;
  }

  /** @returns {object|null} CapabilityInstallReport or null */
  function getCapabilities() {
    return snapshot.capabilities;
  }

  /**
   * @param {object|null} report
   */
  function setCapabilities(report) {
    snapshot.capabilities = report == null ? null : report;
  }

  /**
   * Apply backend InitResponse fields onto the store (does not touch phase/runtime).
   * @param {import('./types.js').InitResponseData} data
   */
  function applyInitPayload(data) {
    const payload = data && typeof data === 'object' ? data : {};
    snapshot.cardName = payload.card_name || 'Conclave';
    snapshot.requirements = payload.runtime_requirements || null;
    snapshot.worldbookEntries = Array.isArray(payload.worldbook_entries)
      ? payload.worldbook_entries
      : [];
    snapshot.tavernHelperScripts = Array.isArray(payload.tavern_helper_scripts)
      ? payload.tavern_helper_scripts
      : [];
    snapshot.importedWorldbooks = Array.isArray(payload.imported_worldbooks)
      ? payload.imported_worldbooks
      : [];
    snapshot.currentWorldbookId = Number.isFinite(Number(payload.current_worldbook_id))
      ? Number(payload.current_worldbook_id)
      : null;
    snapshot.openingRawMessages = [
      payload.first_message || '',
      ...((Array.isArray(payload.greetings) && payload.greetings) || []),
    ];
    snapshot.openingRenderedMessages = [
      payload.rendered_html || '',
      ...((Array.isArray(payload.rendered_greetings) && payload.rendered_greetings) || []),
    ];
    snapshot.capabilities = null;
    snapshot.lastError = null;
  }

  /**
   * Reset card payload fields and runtime (phase left to Kernel).
   */
  function resetCardData() {
    snapshot.cardName = '';
    snapshot.currentWorldbookId = null;
    snapshot.worldbookEntries = [];
    snapshot.tavernHelperScripts = [];
    snapshot.importedWorldbooks = [];
    snapshot.openingRawMessages = [''];
    snapshot.openingRenderedMessages = [''];
    snapshot.requirements = null;
    snapshot.runtime = null;
    snapshot.capabilities = null;
  }

  return {
    getSnapshot,
    getPhase,
    setPhase,
    getLastError,
    setLastError,
    getCardName,
    getCurrentWorldbookId,
    getWorldbookEntries,
    getTavernHelperScripts,
    getImportedWorldbooks,
    getOpeningRawMessages,
    getOpeningRenderedMessages,
    getRequirements,
    getRuntime,
    setRuntime,
    clearRuntime,
    getCapabilities,
    setCapabilities,
    applyInitPayload,
    resetCardData,
  };
}

/**
 * @typedef {ReturnType<typeof createSessionStore>} SessionStore
 */
