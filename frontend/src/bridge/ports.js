/**
 * Port interface definitions (JSDoc only).
 * Mind and other non-ST layers depend on these shapes — never on st-host.
 *
 * See docs/architecture-host-mind.md §7.
 *
 * @module bridge/ports
 */

/**
 * @typedef {Object} ChatMessage
 * @property {number} message_id
 * @property {'user'|'assistant'|'system'} [role]
 * @property {string} [name]
 * @property {boolean} [is_hidden]
 * @property {string} [message]
 * @property {object} [data]
 * @property {object} [extra]
 * @property {number} [swipe_id]
 * @property {string[]} [swipes]
 * @property {string[]} [rendered_swipes]
 * @property {object[]} [swipes_data]
 * @property {object[]} [swipes_info]
 */

/**
 * @typedef {Object} ChatTranscript
 * @property {() => ChatMessage[]} getMessages
 * @property {(msg: Partial<ChatMessage>) => ChatMessage} append
 * @property {(id: number, patch: object) => void} update
 * @property {() => object} getMvu
 * @property {(mvu: object, reason: string) => void} replaceMvu
 */

/**
 * @typedef {Object} InjectionPayload
 * @property {string} content
 * @property {'system'|'user'|'assistant'} [role]
 * @property {string} [position]
 * @property {number} [depth]
 * @property {boolean} [ephemeral]
 * @property {string} [source]
 */

/**
 * @typedef {Object} PromptInjection
 * @property {(key: string, payload: InjectionPayload) => void} set
 * @property {(key: string) => void} clear
 * @property {() => Array<InjectionPayload & { key: string }>} list
 */

/**
 * @typedef {'sessionLoading'|'sessionReady'|'beforeGenerate'|'afterGenerate'|'sessionTeardown'|'capabilityInstalled'} LifecycleEvent
 */

/**
 * @typedef {Object} Lifecycle
 * @property {(event: LifecycleEvent, fn: Function) => () => void} on
 * @property {(event: LifecycleEvent, payload?: any) => Promise<void>} emit
 * @property {() => void} [clear]
 */

/**
 * @typedef {Object} DiagnosticEntry
 * @property {number} ts
 * @property {'info'|'warn'|'error'} level
 * @property {string} code
 * @property {any} [detail]
 * @property {string} [kind]  // 'log' | 'gauge'
 * @property {string} [name]
 * @property {number} [value]
 */

/**
 * @typedef {Object} Diagnostics
 * @property {(level: 'info'|'warn'|'error', code: string, detail?: any) => void} log
 * @property {(name: string, value: number) => void} gauge
 * @property {() => DiagnosticEntry[]} tail
 */

/**
 * @typedef {Object} Ports
 * @property {ChatTranscript} transcript
 * @property {PromptInjection} promptInjection
 * @property {Lifecycle} lifecycle
 * @property {Diagnostics} diagnostics
 */

export {};
