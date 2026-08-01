/**
 * Assemble Ports for Mind / diagnostics consumers.
 * Must not import st-host or shell (architecture boundary).
 *
 * @module bridge/createPorts
 */

/**
 * @returns {import('./ports.js').Lifecycle}
 */
export function createLifecycle() {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();

  /**
   * @param {import('./ports.js').LifecycleEvent} event
   * @param {Function} fn
   * @returns {() => void}
   */
  function on(event, fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('Lifecycle.on: handler must be a function');
    }
    const key = String(event);
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(fn);
    return () => {
      listeners.get(key)?.delete(fn);
    };
  }

  /**
   * @param {import('./ports.js').LifecycleEvent} event
   * @param {any} [payload]
   */
  async function emit(event, payload) {
    const key = String(event);
    const set = listeners.get(key);
    if (!set || !set.size) return;
    for (const fn of [...set]) {
      await fn(payload);
    }
  }

  function clear() {
    listeners.clear();
  }

  return { on, emit, clear };
}

/**
 * @param {{ maxEntries?: number }} [options]
 * @returns {import('./ports.js').Diagnostics}
 */
export function createDiagnostics(options = {}) {
  const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : 100;
  /** @type {import('./ports.js').DiagnosticEntry[]} */
  const entries = [];

  /**
   * @param {import('./ports.js').DiagnosticEntry} entry
   */
  function push(entry) {
    entries.push(entry);
    while (entries.length > maxEntries) entries.shift();
  }

  return {
    log(level, code, detail) {
      push({
        ts: Date.now(),
        kind: 'log',
        level: level || 'info',
        code: String(code || 'unknown'),
        detail,
      });
      const method =
        level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
      console[method]?.(`[Diagnostics] ${code}`, detail);
    },
    gauge(name, value) {
      const n = Number(value);
      push({
        ts: Date.now(),
        kind: 'gauge',
        level: 'info',
        code: 'gauge',
        name: String(name || ''),
        value: Number.isFinite(n) ? n : 0,
      });
    },
    tail() {
      return entries.slice();
    },
  };
}

/**
 * @param {{
 *   getRuntime: () => { runtimeState?: { messages?: object[], mvuData?: object } } | null | undefined,
 *   diagnostics?: import('./ports.js').Diagnostics,
 * }} options
 * @returns {import('./ports.js').Ports}
 */
export function createPorts(options) {
  if (!options || typeof options.getRuntime !== 'function') {
    throw new Error('createPorts: getRuntime is required');
  }

  const { getRuntime } = options;
  const lifecycle = createLifecycle();
  const diagnostics = options.diagnostics || createDiagnostics();

  /** @type {Map<string, import('./ports.js').InjectionPayload & { key: string }>} */
  const injections = new Map();

  /**
   * @returns {object[]}
   */
  function messages() {
    const state = getRuntime()?.runtimeState;
    if (!state || !Array.isArray(state.messages)) return [];
    return state.messages;
  }

  const transcript = {
    getMessages() {
      return messages().slice();
    },

    /**
     * @param {Partial<import('./ports.js').ChatMessage>} msg
     */
    append(msg = {}) {
      const list = getRuntime()?.runtimeState?.messages;
      if (!Array.isArray(list)) {
        throw new Error('ChatTranscript.append: runtime messages unavailable');
      }
      const isUser = msg.role === 'user';
      const text = msg.message ?? '';
      const entry = {
        message_id: list.length,
        role: msg.role || 'assistant',
        name: msg.name || (isUser ? 'User' : 'assistant'),
        is_hidden: !!msg.is_hidden,
        message: String(text),
        data: msg.data && typeof msg.data === 'object' ? msg.data : {},
        extra: msg.extra && typeof msg.extra === 'object' ? msg.extra : {},
        swipe_id: Number.isFinite(Number(msg.swipe_id)) ? Number(msg.swipe_id) : 0,
        swipes: Array.isArray(msg.swipes) ? msg.swipes : [String(text)],
        rendered_swipes: Array.isArray(msg.rendered_swipes) ? msg.rendered_swipes : [''],
        swipes_data: Array.isArray(msg.swipes_data)
          ? msg.swipes_data
          : [msg.data && typeof msg.data === 'object' ? msg.data : {}],
        swipes_info: Array.isArray(msg.swipes_info) ? msg.swipes_info : [{}],
      };
      list.push(entry);
      return entry;
    },

    /**
     * @param {number} id
     * @param {object} patch
     */
    update(id, patch) {
      const list = getRuntime()?.runtimeState?.messages;
      if (!Array.isArray(list)) {
        throw new Error('ChatTranscript.update: runtime messages unavailable');
      }
      const index = Number(id);
      if (!list[index]) {
        throw new Error(`ChatTranscript.update: message ${id} not found`);
      }
      Object.assign(list[index], patch || {});
    },

    getMvu() {
      return getRuntime()?.runtimeState?.mvuData || {};
    },

    /**
     * @param {object} mvu
     * @param {string} reason
     */
    replaceMvu(mvu, reason) {
      if (!reason || typeof reason !== 'string') {
        throw new Error('ChatTranscript.replaceMvu: reason is required');
      }
      const state = getRuntime()?.runtimeState;
      if (!state) {
        throw new Error('ChatTranscript.replaceMvu: runtime unavailable');
      }
      state.mvuData = mvu && typeof mvu === 'object' ? mvu : {};
      diagnostics.log('info', 'transcript.replaceMvu', { reason });
    },
  };

  const promptInjection = {
    /**
     * @param {string} key
     * @param {import('./ports.js').InjectionPayload} payload
     */
    set(key, payload) {
      const id = String(key || '');
      if (!id) throw new Error('PromptInjection.set: key is required');
      if (!payload || typeof payload.content !== 'string') {
        throw new Error('PromptInjection.set: payload.content string is required');
      }
      injections.set(id, {
        key: id,
        content: payload.content,
        role: payload.role,
        position: payload.position,
        depth: payload.depth,
        ephemeral: payload.ephemeral,
        source: payload.source,
      });
    },

    /**
     * @param {string} key
     */
    clear(key) {
      injections.delete(String(key || ''));
    },

    list() {
      return [...injections.values()].map((item) => ({ ...item }));
    },
  };

  return {
    transcript,
    promptInjection,
    lifecycle,
    diagnostics,
  };
}
