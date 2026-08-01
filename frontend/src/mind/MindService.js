/**
 * Mind service — ports-only consumer (no st-host / shell imports).
 * @module mind/MindService
 */

import { createMemoryStore } from './MemoryStore.js';
import { composePrompt } from './promptCompose.js';
import { extractCandidates } from './RuleExtractor.js';
import { DEFAULT_TAXONOMY, createPrimaryNpc } from './taxonomy.js';

export { isMindEnabled } from './flags.js';
export { composePrompt } from './promptCompose.js';
export { extractCandidates } from './RuleExtractor.js';
export { createMemoryStore } from './MemoryStore.js';

const MIND_INJECTION_KEY = 'mind.primary';

/**
 * @param {{
 *   transcript: import('../bridge/ports.js').ChatTranscript,
 *   promptInjection: import('../bridge/ports.js').PromptInjection,
 *   lifecycle: import('../bridge/ports.js').Lifecycle,
 *   diagnostics: import('../bridge/ports.js').Diagnostics,
 *   primaryName?: string,
 *   sessionId?: string,
 *   onSnapshot?: (snap: import('./types.js').MindSnapshot) => void,
 * }} deps
 */
export function createMindService({
  transcript,
  promptInjection,
  lifecycle,
  diagnostics,
  primaryName,
  sessionId,
  onSnapshot,
}) {
  if (!transcript || !promptInjection || !lifecycle || !diagnostics) {
    throw new Error(
      'createMindService: transcript, promptInjection, lifecycle, diagnostics are required',
    );
  }

  const store = createMemoryStore({ sessionId: sessionId != null ? String(sessionId) : '0' });
  let primary = createPrimaryNpc(primaryName || 'NPC');
  /** @type {import('./types.js').MindInjectionDebug | null} */
  let lastInjection = null;
  /** @type {Array<() => void>} */
  const unsubs = [];

  function emitSnapshot() {
    if (typeof onSnapshot !== 'function') return;
    try {
      onSnapshot(getSnapshot());
    } catch {
      /* ignore snapshot consumer errors */
    }
  }

  /**
   * @returns {import('./types.js').MindSnapshot}
   */
  function getSnapshot() {
    return {
      npcs: [{ ...primary }],
      taxonomy: DEFAULT_TAXONOMY,
      memories: store.listActive(),
      cleanup: store.getCleanupStats(),
      lastInjection: lastInjection ? { ...lastInjection } : null,
    };
  }

  function boot(payload) {
    if (payload?.cardName) {
      primary = createPrimaryNpc(String(payload.cardName));
    }
    diagnostics.log('info', 'mind.boot', {
      npc: primary.displayName,
      enabled: true,
    });
    emitSnapshot();
  }

  async function onBeforeGenerate() {
    try {
      const memories = store.retrieve({
        k: 8,
        maxChars: 2000,
        npcId: primary.id,
      });
      const body = composePrompt(memories, primary);
      promptInjection.set(MIND_INJECTION_KEY, {
        content: body,
        role: 'system',
        position: 'after_scenario',
        depth: 0,
        ephemeral: true,
        source: 'mind',
      });
      lastInjection = {
        content: body,
        chars: body.length,
        at: Date.now(),
        memoryCount: memories.length,
      };
      diagnostics.gauge('mind.active_memories', store.activeCount());
      diagnostics.gauge('mind.injection_chars', body.length);
      emitSnapshot();
    } catch (error) {
      diagnostics.log('error', 'mind.beforeGenerate', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * @param {{ raw?: string, messageId?: number }} [payload]
   */
  function extractAndStore(payload = {}) {
    try {
      const messages = transcript.getMessages() || [];
      const candidates = extractCandidates(messages, primary, {
        sessionId: sessionId != null ? String(sessionId) : '0',
        sourceMessageId: payload.messageId,
      });
      if (!candidates.length) {
        diagnostics.log('info', 'mind.extract_empty', {
          messageId: payload.messageId,
        });
        emitSnapshot();
        return { inserted: 0, merged: 0 };
      }
      const result = store.insertMany(candidates);
      diagnostics.gauge('mind.active_memories', store.activeCount());
      diagnostics.gauge('mind.last_cleanup_at', store.getCleanupStats().lastRunAt);
      diagnostics.log('info', 'mind.extract', {
        inserted: result.inserted,
        merged: result.merged,
        active: store.activeCount(),
      });
      emitSnapshot();
      return result;
    } catch (error) {
      diagnostics.log('error', 'mind.extract', {
        message: error instanceof Error ? error.message : String(error),
      });
      return { inserted: 0, merged: 0, error: true };
    }
  }

  function onAfterGenerate(payload) {
    // Never write mvu / lorebook / chat — only MemoryStore.
    extractAndStore(payload || {});
  }

  unsubs.push(lifecycle.on('sessionReady', boot));
  unsubs.push(lifecycle.on('beforeGenerate', onBeforeGenerate));
  unsubs.push(lifecycle.on('afterGenerate', onAfterGenerate));

  function dispose() {
    for (const off of unsubs) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    unsubs.length = 0;
    try {
      promptInjection.clear(MIND_INJECTION_KEY);
    } catch {
      /* ignore */
    }
    store.clear();
    lastInjection = null;
  }

  return {
    getSnapshot,
    getLastInjection: () => (lastInjection ? { ...lastInjection } : null),
    getStore: () => store,
    getPrimaryNpc: () => ({ ...primary }),
    setPrimaryName(name) {
      primary = createPrimaryNpc(name || primary.displayName);
      emitSnapshot();
    },
    extractAndStore,
    dispose,
    /** @internal */
    _injectionKey: MIND_INJECTION_KEY,
  };
}
