/**
 * SessionStore — single source of truth for session snapshot fields.
 * @module session/SessionStore
 */

import {
  applyMvuToRuntimeState,
  buildChatMessageEntry,
} from '../shared/chatTranscript.js';

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
    regexScripts: [],
    sessionEpoch: 0,
    importedWorldbooks: [],
    openingRawMessages: [''],
    openingRenderedMessages: [''],
    requirements: null,
    runtime: null,
    capabilities: null,
    /** Mind snapshot when feature flag on; always null when Mind off (PR-11). */
    mind: null,
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

  /** @returns {Array<object>} Card regex_scripts for FE display pipeline (PR-06). */
  function getRegexScripts() {
    return snapshot.regexScripts;
  }

  /**
   * Replace card regex_scripts (TH auto-regex enable path).
   * @param {Array<object>} scripts
   */
  function setRegexScripts(scripts) {
    snapshot.regexScripts = Array.isArray(scripts) ? scripts : [];
  }

  /** @returns {number} Session epoch from backend (bumps on import/select). */
  function getSessionEpoch() {
    return snapshot.sessionEpoch;
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
    snapshot.regexScripts = Array.isArray(payload.regex_scripts)
      ? payload.regex_scripts
      : [];
    snapshot.sessionEpoch = Number.isFinite(Number(payload.session_epoch))
      ? Number(payload.session_epoch)
      : 0;
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
    snapshot.regexScripts = [];
    snapshot.sessionEpoch = 0;
    snapshot.importedWorldbooks = [];
    snapshot.openingRawMessages = [''];
    snapshot.openingRenderedMessages = [''];
    snapshot.requirements = null;
    snapshot.runtime = null;
    snapshot.capabilities = null;
    snapshot.mind = null;
  }

  /**
   * PR-11: Mind snapshot (null when feature flag off).
   * @returns {object|null}
   */
  function getMind() {
    return snapshot.mind;
  }

  /**
   * @param {object|null} mind
   */
  function setMind(mind) {
    snapshot.mind = mind == null ? null : mind;
  }

  /**
   * PR-07: Session-facing view of chat transcript (runtimeState.messages).
   * TH getChatMessages / MessageMount read this same array.
   * @returns {object[]}
   */
  function getMessages() {
    const list = snapshot.runtime?.runtimeState?.messages;
    return Array.isArray(list) ? list : [];
  }

  /**
   * PR-07: Session-facing MVU snapshot (runtimeState.mvuData).
   * @returns {object}
   */
  function getMvu() {
    return snapshot.runtime?.runtimeState?.mvuData || {};
  }

  /**
   * PR-07: Append a chat message to Session transcript.
   * Production Kernel write path is ports.transcript.append; this is a thin
   * mirror for tests/TH that shares field shape via shared/chatTranscript.
   * @param {Partial<import('./types.js').ChatMessage>} msg
   * @returns {object}
   */
  function appendMessage(msg = {}) {
    const state = snapshot.runtime?.runtimeState;
    if (!state || !Array.isArray(state.messages)) {
      throw new Error('SessionStore.appendMessage: runtime messages unavailable');
    }
    const entry = buildChatMessageEntry(state.messages.length, msg);
    state.messages.push(entry);
    return entry;
  }

  /**
   * PR-07: Replace session MVU and latest assistant message data (server new_state).
   * Production Kernel write path is ports.transcript.replaceMvu; shares apply
   * logic with Ports via shared/chatTranscript.applyMvuToRuntimeState.
   * @param {object} mvu
   * @param {string} [reason]
   */
  function replaceMvu(mvu, reason = 'session.replaceMvu') {
    const state = snapshot.runtime?.runtimeState;
    if (!state) {
      throw new Error('SessionStore.replaceMvu: runtime unavailable');
    }
    applyMvuToRuntimeState(state, mvu);
    void reason;
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
    getRegexScripts,
    setRegexScripts,
    getSessionEpoch,
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
    getMind,
    setMind,
    getMessages,
    getMvu,
    appendMessage,
    replaceMvu,
  };
}

/**
 * @typedef {ReturnType<typeof createSessionStore>} SessionStore
 */
