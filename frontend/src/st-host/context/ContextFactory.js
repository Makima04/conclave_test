/**
 * ContextFactory — minimal real SillyTavern.getContext() (§5.1 matrix).
 *
 * Iron rule (KD2): getContext() NEVER returns TavernHelper.
 * getContext().chat is a LIVE reference to runtime messages so length updates.
 *
 * P0 (PR-04): core ready fields + generation stubs.
 * P2 (PR-10): wireable generate/stopGeneration, persistable chatMetadata,
 *             ST-closer message shape, SlashCommandParser subset, slash expand.
 *
 * @module st-host/context/ContextFactory
 */

const MINIMAL_EVENT_TYPES = {
  VARIABLE_INITIALIZED: 'mag_variable_initiailized',
  VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
  COMMAND_PARSED: 'mag_command_parsed',
  VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
  BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
};

/**
 * Frozen progress table for §5.1 getContext field matrix (P0 / P2).
 * Values: 'ready' | 'wireable' | 'stub' | 'missing'
 *
 * @type {Readonly<Record<string, { p0: string, p2: string, note?: string }>>}
 */
export const CONTEXT_FIELD_MATRIX = Object.freeze({
  chat: {
    p0: 'ready',
    p2: 'ready',
    note: 'live Session messages; P2 adds ST aliases (mes/is_user/is_system/send_date)',
  },
  characters: { p0: 'ready', p2: 'ready', note: 'current card entry; expandable' },
  name1: { p0: 'ready', p2: 'ready' },
  name2: { p0: 'ready', p2: 'ready' },
  characterId: { p0: 'ready', p2: 'ready', note: 'numeric placeholder; multi-session later' },
  chatId: { p0: 'ready', p2: 'ready', note: 'string placeholder; multi-session later' },
  chatMetadata: { p0: 'ready', p2: 'ready', note: 'P2: session-live mutable object + updateChatMetadata' },
  eventSource: { p0: 'ready', p2: 'ready' },
  eventTypes: { p0: 'ready', p2: 'ready' },
  event_types: { p0: 'ready', p2: 'ready' },
  addOneMessage: { p0: 'ready', p2: 'ready' },
  generate: {
    p0: 'stub',
    p2: 'wireable',
    note: 'inject generateFn; default still rejects until host wires chat path',
  },
  stopGeneration: {
    p0: 'stub',
    p2: 'wireable',
    note: 'inject stopGenerationFn; tracks isGenerating',
  },
  setExtensionPrompt: { p0: 'ready', p2: 'ready' },
  extensionPrompts: { p0: 'ready', p2: 'ready' },
  executeSlashCommandsWithOptions: {
    p0: 'stub',
    p2: 'ready',
    note: 'P2: parser registry + /echo; inject executeSlash for host slash.runtime',
  },
  SlashCommandParser: {
    p0: 'stub',
    p2: 'ready',
    note: 'P2 subset: addCommandObject / getCommands / parse no-op',
  },
  'variables.local': { p0: 'ready', p2: 'ready' },
  'variables.global': { p0: 'ready', p2: 'ready' },
  updateChatMetadata: { p0: 'missing', p2: 'ready', note: 'generation-path helper' },
  getCurrentChatId: { p0: 'missing', p2: 'ready', note: 'generation-path helper' },
  deleteLastMessage: { p0: 'missing', p2: 'ready', note: 'generation-path helper (array pop)' },
  // Large ST objects intentionally absent unless an extension needs them later.
  tokenizers: { p0: 'missing', p2: 'missing' },
  ToolManager: { p0: 'missing', p2: 'missing' },
  Popup: { p0: 'missing', p2: 'missing' },
});

/**
 * @returns {{ on: Function, once: Function, emit: Function, removeListener: Function }}
 */
function createStubEventSource() {
  const warn = (method) => {
    console.warn(`[ConclaveSTHost] getContext().eventSource.${method} stub (no event bus)`);
  };
  return {
    on: () => {
      warn('on');
      return { stop() {} };
    },
    once: () => {
      warn('once');
      return { stop() {} };
    },
    emit: async () => {
      warn('emit');
    },
    removeListener: () => {
      warn('removeListener');
    },
  };
}

/**
 * Minimal ST-shaped SlashCommandParser subset (P2).
 * @returns {object}
 */
function createSlashCommandParser() {
  /** @type {Map<string, object>} */
  const commands = new Map();

  return {
    /**
     * @param {object} cmd  // { name, callback?, helpString?, ... }
     */
    addCommandObject(cmd) {
      if (!cmd || typeof cmd !== 'object') return;
      const name = String(cmd.name || cmd.command || '').replace(/^\//, '');
      if (!name) return;
      commands.set(name, cmd);
    },
    /**
     * @param {string} name
     * @returns {object|undefined}
     */
    getCommand(name) {
      return commands.get(String(name || '').replace(/^\//, ''));
    },
    /**
     * @returns {object[]}
     */
    getCommands() {
      return [...commands.values()];
    },
    /**
     * Parse is a no-op subset until full slash AST lands.
     * @returns {null}
     */
    parse() {
      return null;
    },
  };
}

/**
 * @typedef {Object} ContextFactoryOptions
 * @property {() => { messages?: object[], variables?: { chat?: object, global?: object }, mvuData?: object } | null | undefined} getRuntimeState
 * @property {() => string} [getCardName]
 * @property {() => string} [getUserName]
 * @property {() => object | null | undefined} [getEventSource]
 * @property {() => Record<string, string>} [getEventTypes]
 * @property {(...args: any[]) => any | Promise<any>} [generateFn]  P2: wire host generate path
 * @property {(...args: any[]) => void} [stopGenerationFn]  P2: wire host stop
 * @property {(text: string, options?: object) => any | Promise<any>} [executeSlashFn]  P2: wire slash.runtime
 * @property {() => string|number|null|undefined} [getChatId]
 * @property {() => number|string|null|undefined} [getCharacterId]
 */

/**
 * @param {ContextFactoryOptions} options
 */
export function createContextFactory({
  getRuntimeState,
  getCardName,
  getUserName,
  getEventSource,
  getEventTypes,
  generateFn,
  stopGenerationFn,
  executeSlashFn,
  getChatId,
  getCharacterId,
} = {}) {
  if (typeof getRuntimeState !== 'function') {
    throw new Error('createContextFactory: getRuntimeState is required');
  }

  /** @type {Record<string, object>} */
  const extensionPrompts = {};

  /** Session-live chat metadata (P2 persistable in-memory). */
  /** @type {Record<string, unknown>} */
  const chatMetadata = {};

  const slashParser = createSlashCommandParser();

  /** In-flight generate() refcount (Issue 6: concurrent generate safety). */
  let generatingCount = 0;

  /**
   * Allow host to (re)bind generate path after factory creation.
   * @param {(...args: any[]) => any | Promise<any> | null | undefined} fn
   */
  function setGenerateFn(fn) {
    generateFn = typeof fn === 'function' ? fn : null;
  }

  /**
   * @param {(...args: any[]) => void | null | undefined} fn
   */
  function setStopGenerationFn(fn) {
    stopGenerationFn = typeof fn === 'function' ? fn : null;
  }

  /**
   * @param {(text: string, options?: object) => any | Promise<any> | null | undefined} fn
   */
  function setExecuteSlashFn(fn) {
    executeSlashFn = typeof fn === 'function' ? fn : null;
  }

  /**
   * ST-compatible extension prompt registration (in-memory map for P0 / Mind Port).
   * @param {string} key
   * @param {string} value
   * @param {number} [position]
   * @param {number} [depth]
   * @param {boolean} [scan]
   * @param {string} [role]
   * @param {unknown} [filter]
   */
  function setExtensionPrompt(key, value, position, depth, scan, role, filter) {
    const id = String(key || '');
    if (!id) return;
    extensionPrompts[id] = {
      value: value == null ? '' : String(value),
      position,
      depth,
      scan,
      role,
      filter,
    };
  }

  function getExtensionPrompts() {
    return extensionPrompts;
  }

  /**
   * Append a message onto the live messages array (ST addOneMessage subset).
   * P2: ST-closer shape with mes / is_user / is_system / send_date aliases.
   * @param {object} [mes]
   */
  function addOneMessage(mes = {}) {
    const state = getRuntimeState();
    if (!state || !Array.isArray(state.messages)) {
      console.warn('[ConclaveSTHost] getContext().addOneMessage: no live messages array');
      return;
    }
    const isUser = !!(mes.is_user || mes.role === 'user');
    const isSystem = !!(mes.is_system || mes.role === 'system');
    const text = mes.mes ?? mes.message ?? '';
    const messageId = state.messages.length;
    const textStr = String(text);
    const data = mes.data && typeof mes.data === 'object' ? mes.data : {};
    const extra = mes.extra && typeof mes.extra === 'object' ? mes.extra : {};
    const sendDate = mes.send_date ?? mes.sendDate ?? Date.now();

    state.messages.push({
      message_id: messageId,
      role: isUser ? 'user' : isSystem ? 'system' : mes.role || 'assistant',
      name: mes.name || (isUser ? 'User' : 'assistant'),
      is_hidden: !!(mes.is_system || mes.is_hidden),
      // Conclave primary field
      message: textStr,
      // ST-compatible aliases (P2 closer message shape)
      mes: textStr,
      is_user: isUser,
      is_system: isSystem,
      send_date: sendDate,
      data,
      extra,
      swipe_id: 0,
      swipes: [textStr],
      rendered_swipes: [''],
      swipes_data: [data && typeof data === 'object' ? data : {}],
      swipes_info: [{}],
    });
  }

  /**
   * Pop the last chat message (ST deleteLastMessage subset).
   * @returns {object|undefined}
   */
  function deleteLastMessage() {
    const state = getRuntimeState();
    if (!state || !Array.isArray(state.messages) || state.messages.length === 0) {
      return undefined;
    }
    return state.messages.pop();
  }

  /**
   * @returns {string}
   */
  function getCurrentChatId() {
    if (typeof getChatId === 'function') {
      const id = getChatId();
      if (id != null && id !== '') return String(id);
    }
    return '0';
  }

  /**
   * Merge or replace chat metadata (ST updateChatMetadata subset).
   * @param {object} [updates]
   * @param {boolean} [replace=false]
   */
  function updateChatMetadata(updates = {}, replace = false) {
    if (replace) {
      for (const key of Object.keys(chatMetadata)) {
        delete chatMetadata[key];
      }
    }
    if (updates && typeof updates === 'object') {
      Object.assign(chatMetadata, updates);
    }
  }

  /**
   * P2 wireable generate: host injects generateFn to connect real chat path.
   * @param {...any} args
   */
  async function generate(...args) {
    if (typeof generateFn === 'function') {
      generatingCount += 1;
      try {
        return await Promise.resolve(generateFn(...args));
      } finally {
        generatingCount = Math.max(0, generatingCount - 1);
      }
    }
    console.warn(
      '[ConclaveSTHost] getContext().generate is wireable but unbound (inject generateFn)',
      args
    );
    return Promise.reject(
      new Error(
        'getContext().generate is not bound — inject generateFn via createContextFactory / setGenerateFn'
      )
    );
  }

  /**
   * @param {...any} args
   */
  function stopGeneration(...args) {
    // Force-clear in-flight flag; host stopGenerationFn should abort underlying work.
    generatingCount = 0;
    if (typeof stopGenerationFn === 'function') {
      stopGenerationFn(...args);
      return;
    }
    console.warn(
      '[ConclaveSTHost] getContext().stopGeneration is wireable but unbound (inject stopGenerationFn)',
      args
    );
  }

  /**
   * @param {string} text
   * @param {object} [options]
   */
  async function executeSlashCommandsWithOptions(text, options = {}) {
    if (typeof executeSlashFn === 'function') {
      return executeSlashFn(text, options);
    }

    const raw = String(text ?? '').trim();
    if (!raw) {
      return { pipe: '', isError: false, isAborted: false, isSuccess: true, interrupt: false };
    }

    // Built-in /echo for smoke tests and TH compatibility.
    const echoMatch = raw.match(/^\/echo(?:\s+([\s\S]*))?$/i);
    if (echoMatch) {
      return {
        pipe: echoMatch[1] ?? '',
        isError: false,
        isAborted: false,
        isSuccess: true,
        interrupt: false,
      };
    }

    // Registered command objects (callback subset).
    const cmdMatch = raw.match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
    if (cmdMatch) {
      const cmd = slashParser.getCommand(cmdMatch[1]);
      if (cmd && typeof cmd.callback === 'function') {
        try {
          const result = await Promise.resolve(cmd.callback(cmdMatch[2] ?? '', options));
          const pipe = result == null ? '' : String(result);
          return { pipe, isError: false, isAborted: false, isSuccess: true, interrupt: false };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn('[ConclaveSTHost] slash command error:', message);
          return {
            pipe: '',
            isError: true,
            isAborted: false,
            isSuccess: false,
            interrupt: false,
            error: message,
          };
        }
      }
    }

    // Unknown slash token: surface as error so typos are not silent success.
    // (ST full parser may differ; Conclave P2 subset prefers explicit failure.)
    console.warn(
      '[ConclaveSTHost] getContext().executeSlashCommandsWithOptions: unknown command',
      text,
      options
    );
    return {
      pipe: '',
      isError: true,
      isAborted: false,
      isSuccess: false,
      interrupt: false,
      error: `unknown slash command: ${raw}`,
    };
  }

  /**
   * Build a fresh context object. chat is always the live messages array reference.
   * @returns {object}
   */
  function getContext() {
    const state = getRuntimeState() || {};
    // LIVE array reference — never clone; length must track Session messages.
    const chat = Array.isArray(state.messages) ? state.messages : [];
    const name1 =
      (typeof getUserName === 'function' ? getUserName() : null) || 'User';
    const name2 =
      (typeof getCardName === 'function' ? getCardName() : null) || 'Character';

    let eventSource =
      typeof getEventSource === 'function' ? getEventSource() : null;
    if (!eventSource || typeof eventSource !== 'object') {
      eventSource = createStubEventSource();
    }

    const eventTypes =
      (typeof getEventTypes === 'function' && getEventTypes()) || MINIMAL_EVENT_TYPES;

    const variables = state.variables || {};

    let characterId = 0;
    if (typeof getCharacterId === 'function') {
      const cid = getCharacterId();
      if (cid != null && cid !== '') characterId = cid;
    }

    const chatId = getCurrentChatId();

    return {
      chat,
      characters: [
        {
          name: name2,
          avatar: '',
          chat: chatId,
        },
      ],
      name1,
      name2,
      characterId,
      chatId,
      // LIVE mutable metadata object (same reference across getContext calls)
      chatMetadata,
      eventSource,
      eventTypes,
      event_types: eventTypes,
      addOneMessage,
      deleteLastMessage,
      generate,
      stopGeneration,
      setExtensionPrompt,
      extensionPrompts,
      executeSlashCommandsWithOptions,
      SlashCommandParser: slashParser,
      updateChatMetadata,
      getCurrentChatId,
      /** P2: true while any generate() call is in flight (refcount). */
      isGenerating: () => generatingCount > 0,
      variables: {
        get local() {
          return variables.chat || {};
        },
        get global() {
          return variables.global || {};
        },
      },
    };
  }

  return {
    getContext,
    setExtensionPrompt,
    getExtensionPrompts,
    addOneMessage,
    deleteLastMessage,
    updateChatMetadata,
    getCurrentChatId,
    setGenerateFn,
    setStopGenerationFn,
    setExecuteSlashFn,
    getSlashCommandParser: () => slashParser,
    /** @deprecated test helper */
    _extensionPrompts: extensionPrompts,
    /** @deprecated test helper */
    _chatMetadata: chatMetadata,
  };
}
