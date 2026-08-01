/**
 * Session Kernel type definitions (JSDoc).
 * See docs/architecture-host-mind.md §3 Session Kernel.
 *
 * @module session/types
 */

/**
 * Lifecycle phases for a card session.
 * @typedef {'idle'|'loading_card'|'installing_capabilities'|'running'|'tearing_down'|'error'} SessionPhase
 */

/**
 * @typedef {Object} CardRef
 * @property {number|null} importId
 * @property {string} name
 * @property {Array<object>} tavernHelperScripts
 * @property {Array<object>} worldbookEntries
 * @property {string[]} openingRaw
 * @property {string[]} openingRenderedHint
 */

/**
 * Chat message shape aligned with TavernHelper / ST host runtime.
 * @typedef {Object} ChatMessage
 * @property {number} message_id
 * @property {'user'|'assistant'|'system'} role
 * @property {string} name
 * @property {boolean} is_hidden
 * @property {string} message
 * @property {object} data
 * @property {object} extra
 * @property {number} swipe_id
 * @property {string[]} swipes
 * @property {string[]} rendered_swipes
 * @property {object[]} swipes_data
 * @property {object[]} swipes_info
 */

/**
 * Variable buckets (chat / character / global / …).
 * @typedef {Object} VariableBuckets
 * @property {object} chat
 * @property {object} character
 * @property {object} global
 * @property {object} preset
 * @property {object} script
 * @property {object} extension
 */

/**
 * Runtime handle produced by main.js createRuntime (PR-02 keeps factory in main).
 * @typedef {Object} SessionRuntime
 * @property {object} runtimeState
 * @property {function} [triggerSlash]
 * @property {function} [eventEmit]
 * @property {object} [adapter] GlobalAdapter for teardown
 * @property {object} [contextFactory]
 * @property {object} [surfaces]
 * @property {object} [capabilityRegistry]
 * @property {object} [eventBus] PR-05 EventBus instance
 */

/**
 * Full session snapshot — SessionStore holds the live copy.
 * PR-02 migrates card/bootstrap fields + runtime ref; messages/mvu authority
 * still lives on runtime.runtimeState until PR-07.
 *
 * @typedef {Object} SessionSnapshot
 * @property {SessionPhase} phase
 * @property {string|null} lastError
 * @property {string} cardName
 * @property {number|null} currentWorldbookId  // import id of active card
 * @property {Array<object>} worldbookEntries
 * @property {Array<object>} tavernHelperScripts
 * @property {Array<object>} regexScripts  // PR-06: card regex_scripts for FE display
 * @property {number} sessionEpoch  // PR-06: bumps on import/select
 * @property {Array<object>} importedWorldbooks
 * @property {string[]} openingRawMessages
 * @property {string[]} openingRenderedMessages  // backend rendered_* hints
 * @property {object|null} requirements  // runtime_requirements from backend
 * @property {SessionRuntime|null} runtime
 * @property {object|null} capabilities  // CapabilityInstallReport; null until install
 */

/**
 * Init / import / select API payload (backend InitResponse).
 * @typedef {Object} InitResponseData
 * @property {string} [card_name]
 * @property {string} [first_message]
 * @property {string} [rendered_html]
 * @property {string[]} [greetings]
 * @property {string[]} [rendered_greetings]
 * @property {Array<object>} [worldbook_entries]
 * @property {Array<object>} [tavern_helper_scripts]
 * @property {Array<object>} [regex_scripts]
 * @property {Array<object>} [imported_worldbooks]
 * @property {number} [current_worldbook_id]
 * @property {number} [session_epoch]
 * @property {object} [runtime_requirements]
 */

export {};
