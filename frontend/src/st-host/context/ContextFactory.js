/**
 * ContextFactory — minimal real SillyTavern.getContext() (P0 matrix §5.1).
 *
 * Iron rule (KD2): getContext() NEVER returns TavernHelper.
 * getContext().chat is a LIVE reference to runtime messages so length updates.
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
 * @typedef {Object} ContextFactoryOptions
 * @property {() => { messages?: object[], variables?: { chat?: object, global?: object }, mvuData?: object } | null | undefined} getRuntimeState
 * @property {() => string} [getCardName]
 * @property {() => string} [getUserName]
 * @property {() => object | null | undefined} [getEventSource]
 * @property {() => Record<string, string>} [getEventTypes]
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
}) {
  if (typeof getRuntimeState !== 'function') {
    throw new Error('createContextFactory: getRuntimeState is required');
  }

  /** @type {Record<string, object>} */
  const extensionPrompts = {};

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
   * @param {object} [mes]
   */
  function addOneMessage(mes = {}) {
    const state = getRuntimeState();
    if (!state || !Array.isArray(state.messages)) {
      console.warn('[ConclaveSTHost] getContext().addOneMessage: no live messages array');
      return;
    }
    const isUser = !!(mes.is_user || mes.role === 'user');
    const text = mes.mes ?? mes.message ?? '';
    const messageId = state.messages.length;
    state.messages.push({
      message_id: messageId,
      role: isUser ? 'user' : mes.role || 'assistant',
      name: mes.name || (isUser ? 'User' : 'assistant'),
      is_hidden: !!(mes.is_system || mes.is_hidden),
      message: String(text),
      data: mes.data && typeof mes.data === 'object' ? mes.data : {},
      extra: mes.extra && typeof mes.extra === 'object' ? mes.extra : {},
      swipe_id: 0,
      swipes: [String(text)],
      rendered_swipes: [''],
      swipes_data: [mes.data && typeof mes.data === 'object' ? mes.data : {}],
      swipes_info: [{}],
    });
  }

  async function generate(...args) {
    console.warn('[ConclaveSTHost] getContext().generate is a stub', args);
    return Promise.reject(new Error('getContext().generate is not implemented in Conclave P0'));
  }

  function stopGeneration(...args) {
    console.warn('[ConclaveSTHost] getContext().stopGeneration is a stub', args);
  }

  async function executeSlashCommandsWithOptions(text, options = {}) {
    console.warn(
      '[ConclaveSTHost] getContext().executeSlashCommandsWithOptions is a stub',
      text,
      options
    );
    return { pipe: '', isError: false, isAborted: false, isSuccess: true, interrupt: false };
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

    return {
      chat,
      characters: [{ name: name2 }],
      name1,
      name2,
      characterId: 0,
      chatId: '0',
      chatMetadata: {},
      eventSource,
      eventTypes,
      event_types: eventTypes,
      addOneMessage,
      generate,
      stopGeneration,
      setExtensionPrompt,
      extensionPrompts,
      executeSlashCommandsWithOptions,
      SlashCommandParser: {},
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
    /** @deprecated test helper */
    _extensionPrompts: extensionPrompts,
  };
}
