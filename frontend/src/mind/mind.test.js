/**
 * PR-11 Mind MVP + PR-12 tuning tests: flag, extractor, dedupe, caps, injection.
 */
import { describe, it, expect } from 'vitest'
import { isMindEnabled, MIND_FEATURE_KEY } from './flags.js'
import {
  extractCandidates,
  isNearDuplicateOfAny,
  looksLikeUiChrome,
  nameHintScore,
  splitCandidateLines,
  textSimilarity,
} from './RuleExtractor.js'
import { contentHash, normalizeText } from './dedupe.js'
import {
  DEFAULT_NPC_CAP,
  DEFAULT_SESSION_CAP,
  enforceActiveCaps,
  purgeCompare,
  retentionScore,
} from './cleanup.js'
import { createMemoryStore } from './MemoryStore.js'
import { composePrompt } from './promptCompose.js'
import { createMindService } from './MindService.js'
import { createPorts } from '../bridge/createPorts.js'
import { createSessionStore } from '../session/SessionStore.js'
import { createSessionKernel } from '../session/SessionKernel.js'

describe('isMindEnabled flag (default off)', () => {
  it('is false with empty storage and no query', () => {
    const storage = { getItem: () => null }
    expect(isMindEnabled({ localStorage: storage, location: { search: '' } })).toBe(false)
  })

  it('is true when localStorage conclave:feature:mind === 1', () => {
    const storage = {
      getItem: (k) => (k === MIND_FEATURE_KEY ? '1' : null),
    }
    expect(isMindEnabled({ localStorage: storage, location: { search: '' } })).toBe(true)
  })

  it('is true when ?mind=1', () => {
    const storage = { getItem: () => null }
    expect(
      isMindEnabled({ localStorage: storage, location: { search: '?mind=1&x=2' } }),
    ).toBe(true)
  })

  it('is false for other mind query values', () => {
    const storage = { getItem: () => null }
    expect(isMindEnabled({ localStorage: storage, location: { search: '?mind=0' } })).toBe(
      false,
    )
  })
})

describe('RuleExtractor', () => {
  it('skips UI chrome / HTML / StatusPlaceHolder / _.set', () => {
    expect(looksLikeUiChrome('<div>hi</div>')).toBe(true)
    expect(looksLikeUiChrome('StatusPlaceHolderImpl')).toBe(true)
    expect(looksLikeUiChrome('_.set(stat_data, "hp", 1)')).toBe(true)
    expect(looksLikeUiChrome('Alice remembers the red door near the market.')).toBe(false)
  })

  it('PR-12: broader chrome — script fences, CSS, JSON, pure symbols', () => {
    expect(looksLikeUiChrome('```js\nconst x = 1\n```')).toBe(true)
    expect(looksLikeUiChrome('.panel { color: red; margin: 0; }')).toBe(true)
    expect(looksLikeUiChrome('{ "hp": 12, "mp": 3 }')).toBe(true)
    expect(looksLikeUiChrome('★★★★')).toBe(true)
    expect(looksLikeUiChrome('import foo from "bar"')).toBe(true)
    expect(looksLikeUiChrome('https://example.com/path')).toBe(true)
    expect(looksLikeUiChrome('<UpdateVariable>x=1</UpdateVariable>')).toBe(true)
    expect(looksLikeUiChrome('林晚记得码头的灯号暗号已经更换。')).toBe(false)
  })

  it('extracts at most N=3 candidates from last K messages, text ≤200', () => {
    const messages = [
      { role: 'assistant', message_id: 0, message: 'Opening fluff that is long enough here.' },
      {
        role: 'user',
        message_id: 1,
        message: 'I am looking for Captain Rivera at the harbor tonight.',
      },
      {
        role: 'assistant',
        message_id: 2,
        message: [
          'Captain Rivera knows the smuggler routes under the pier.',
          '<div class="ui">ignore</div>',
          'StatusPlaceHolder',
          '_.set(x,1)',
          'Short',
          'The warehouse on Maple Street hides a coded ledger about debts.',
          'She told User that the password is silver-dawn for the east gate.',
        ].join('\n'),
      },
    ]
    const npc = { id: 'primary', displayName: 'Rivera' }
    const out = extractCandidates(messages, npc, { maxCandidates: 3 })
    expect(out.length).toBeGreaterThan(0)
    expect(out.length).toBeLessThanOrEqual(3)
    for (const m of out) {
      expect(m.text.length).toBeGreaterThanOrEqual(8)
      expect(m.text.length).toBeLessThanOrEqual(200)
      expect(m.labels).toEqual(['knowledge/unspecified'])
      expect(m.contentHash).toBe(contentHash('primary', m.text))
      expect(looksLikeUiChrome(m.text)).toBe(false)
    }
  })

  it('splitCandidateLines breaks on newlines and CJK/EN sentence ends', () => {
    const mixed = splitCandidateLines('One line。Two line. Three！Four? Five')
    expect(mixed.some((l) => l.includes('One'))).toBe(true)
    expect(mixed.length).toBeGreaterThanOrEqual(4)

    const zh = splitCandidateLines('林晚走进酒馆。她记得旧暗号。码头起雾了！')
    expect(zh).toHaveLength(3)
    expect(zh[0]).toContain('林晚')
  })

  it('avoids near-duplicates within a single extract turn', () => {
    const messages = [
      {
        role: 'assistant',
        message_id: 0,
        message: [
          'Alice remembers the red door near the old market square.',
          'Alice remembers the red door near the old market.',
          'Bob knows the silver password for the east gate tonight.',
        ].join('\n'),
      },
    ]
    const out = extractCandidates(messages, { id: 'primary' }, { maxCandidates: 3 })
    expect(out.length).toBeLessThanOrEqual(2)
    // Near-dup Alice lines collapse to one; Bob remains.
    const texts = out.map((m) => m.text)
    expect(texts.some((t) => /Alice|red door/i.test(t))).toBe(true)
    expect(texts.some((t) => /Bob|silver password/i.test(t))).toBe(true)
  })

  it('textSimilarity / isNearDuplicateOfAny detect overlapping facts', () => {
    expect(
      textSimilarity(
        'Alice remembers the red door near the market',
        'Alice remembers the red door near the market square',
      ),
    ).toBeGreaterThan(0.8)
    expect(
      isNearDuplicateOfAny('Captain Rivera knows the pier routes', [
        'Captain Rivera knows the pier routes under fog',
      ]),
    ).toBe(true)
    expect(nameHintScore('Alice told Bob the secret')).toBeGreaterThan(0)
  })
})

describe('MemoryStore dedupe + cleanup', () => {
  it('dedupes by contentHash and merges scores/labels', () => {
    const store = createMemoryStore({ sessionCap: 200, npcCap: 120 })
    const text = 'Alice is cautious around strangers in the market.'
    const hash = contentHash('primary', text)
    const r1 = store.insertMany([
      {
        npcId: 'primary',
        text,
        contentHash: hash,
        labels: ['knowledge/unspecified'],
        scores: { knowledge: 0.5 },
      },
    ])
    expect(r1.inserted).toBe(1)
    const r2 = store.insertMany([
      {
        npcId: 'primary',
        text,
        contentHash: hash,
        labels: ['relation/stranger'],
        scores: { knowledge: 0.8, relation: 0.4 },
      },
    ])
    expect(r2.inserted).toBe(0)
    expect(r2.merged).toBe(1)
    expect(store.activeCount()).toBe(1)
    const active = store.listActive()[0]
    expect(active.labels).toEqual(
      expect.arrayContaining(['knowledge/unspecified', 'relation/stranger']),
    )
    expect(active.scores.knowledge).toBe(0.8)
    expect(active.scores.relation).toBe(0.4)
    expect(active.accessCount).toBeGreaterThanOrEqual(1)
  })

  it('normalizeText collapses case and punctuation for hashing', () => {
    expect(normalizeText('  Hello, World! ')).toBe('hello world')
    expect(contentHash('a', 'Hello')).toBe(contentHash('a', 'hello'))
  })

  it('enforce session/npc active caps', () => {
    const store = createMemoryStore({ sessionCap: 5, npcCap: 3 })
    for (let i = 0; i < 10; i += 1) {
      store.insertMany([
        {
          npcId: 'primary',
          text: `Unique memory fact number ${i} about the world and people.`,
          scores: { knowledge: 0.1 * (i % 5) },
        },
      ])
    }
    expect(store.activeCount()).toBeLessThanOrEqual(3)
  })

  it('PR-12: 50-turn extract path keeps activeCount under session/npc caps', () => {
    const sessionCap = 40
    const npcCap = 30
    const store = createMemoryStore({ sessionCap, npcCap })
    const npc = { id: 'primary', displayName: 'Demo' }
    const messages = []
    const base = Date.now()

    for (let turn = 0; turn < 50; turn += 1) {
      const userId = turn * 2
      const asstId = turn * 2 + 1
      messages.push({
        role: 'user',
        message_id: userId,
        message: `Turn ${turn}: I met Contact${turn} at district ${turn % 7} near landmark ${turn}.`,
      })
      messages.push({
        role: 'assistant',
        message_id: asstId,
        message: [
          `Contact${turn} knows secret code alpha-${turn} about the northern vault.`,
          `StatusPlaceHolderImpl`,
          `_.set(stat_data, "turn", ${turn})`,
          `<div class="chrome">ui</div>`,
          `The ledger entry ${turn} lists a debt owed by Merchant${turn} in the harbor.`,
          `Contact${turn} knows secret code alpha-${turn} about the northern vault again.`,
        ].join('\n'),
      })

      const candidates = extractCandidates(messages, npc, {
        maxCandidates: 3,
        now: base + turn * 1000,
        sourceMessageId: asstId,
      })
      store.insertMany(candidates, { now: base + turn * 1000 })
      expect(store.activeCount()).toBeLessThanOrEqual(Math.min(sessionCap, npcCap))
    }

    expect(store.activeCount()).toBeLessThanOrEqual(npcCap)
    expect(store.activeCount()).toBeLessThanOrEqual(sessionCap)
    expect(store.activeCount()).toBeGreaterThan(0)
    // Defaults documented for production path
    expect(DEFAULT_SESSION_CAP).toBe(200)
    expect(DEFAULT_NPC_CAP).toBe(120)
  })

  it('PR-12: retention prefers high salience + recent touch; purgeCompare deterministic', () => {
    const now = 1_700_000_000_000
    const oldLow = {
      id: 'a',
      scores: { knowledge: 0.1 },
      createdAt: now - 10 * 24 * 60 * 60 * 1000,
      updatedAt: now - 10 * 24 * 60 * 60 * 1000,
      lastAccessedAt: now - 10 * 24 * 60 * 60 * 1000,
      accessCount: 0,
    }
    const freshHigh = {
      id: 'b',
      scores: { knowledge: 0.9 },
      createdAt: now - 1000,
      updatedAt: now - 1000,
      lastAccessedAt: now,
      accessCount: 4,
    }
    expect(retentionScore(freshHigh, now)).toBeGreaterThan(retentionScore(oldLow, now))
    expect(purgeCompare(oldLow, freshHigh, now)).toBeLessThan(0)

    const records = []
    for (let i = 0; i < 8; i += 1) {
      records.push({
        id: `m${i}`,
        npcId: 'primary',
        status: 'active',
        text: `fact ${i}`,
        scores: { knowledge: 0.5 },
        createdAt: now - i * 1000,
        updatedAt: now - i * 1000,
        lastAccessedAt: now - i * 1000,
        accessCount: 0,
      })
    }
    const result = enforceActiveCaps(records, { sessionCap: 3, npcCap: 3, now })
    expect(result.activeCount).toBe(3)
    expect(records.filter((r) => r.status === 'active')).toHaveLength(3)
  })

  it('retrieve returns top-k within maxChars', () => {
    const store = createMemoryStore()
    store.insertMany([
      { npcId: 'primary', text: 'Alpha fact about the northern tower watch.', scores: { knowledge: 0.9 } },
      { npcId: 'primary', text: 'Beta fact about the river ferry schedule.', scores: { knowledge: 0.2 } },
      { npcId: 'primary', text: 'Gamma fact about the sealed archive key.', scores: { knowledge: 0.7 } },
    ])
    const top = store.retrieve({ k: 2, maxChars: 2000 })
    expect(top).toHaveLength(2)
    expect(top[0].text).toContain('Alpha')
  })
})

describe('composePrompt', () => {
  it('formats the Mind block with primary NPC name', () => {
    const body = composePrompt(
      [
        {
          text: 'User likes tea.',
          labels: ['knowledge/unspecified'],
        },
      ],
      { displayName: 'Demo', id: 'primary' },
    )
    expect(body).toContain('[Conclave Mind — primary NPC: Demo]')
    expect(body).toContain('- [knowledge/unspecified] User likes tea.')
    expect(body).toContain('(Do not mention this block unless character would know it.)')
  })
})

describe('createMindService lifecycle', () => {
  function runtimeBundle() {
    const messages = []
    const runtimeState = { messages, mvuData: { stat_data: {} } }
    return {
      runtimeState,
      getRuntime: () => ({ runtimeState }),
    }
  }

  it('beforeGenerate sets mind.primary injection; flag-off path has no service', async () => {
    const { getRuntime, runtimeState } = runtimeBundle()
    const ports = createPorts({ getRuntime })
    runtimeState.messages.push({
      message_id: 0,
      role: 'assistant',
      message: 'Welcome traveler to the quiet harbor town tonight.',
      data: {},
    })

    const mind = createMindService({
      transcript: ports.transcript,
      promptInjection: ports.promptInjection,
      lifecycle: ports.lifecycle,
      diagnostics: ports.diagnostics,
      primaryName: 'Demo',
    })

    // seed a memory so injection is non-trivial
    mind.getStore().insertMany([
      {
        npcId: 'primary',
        text: 'User likes tea in the morning at the inn.',
        labels: ['knowledge/unspecified'],
        scores: { knowledge: 0.6 },
      },
    ])

    await ports.lifecycle.emit('beforeGenerate', { userMessage: 'hi' })
    const list = ports.promptInjection.list()
    expect(list).toHaveLength(1)
    expect(list[0].key).toBe('mind.primary')
    expect(list[0].source).toBe('mind')
    expect(list[0].position).toBe('after_scenario')
    expect(list[0].content).toContain('[Conclave Mind — primary NPC: Demo]')
    expect(list[0].content).toContain('User likes tea')
    expect(mind.getLastInjection()?.content).toBe(list[0].content)

    mind.dispose()
    expect(ports.promptInjection.list()).toHaveLength(0)
  })

  it('afterGenerate extracts and stores without touching mvu', async () => {
    const { getRuntime, runtimeState } = runtimeBundle()
    const ports = createPorts({ getRuntime })
    const mind = createMindService({
      transcript: ports.transcript,
      promptInjection: ports.promptInjection,
      lifecycle: ports.lifecycle,
      diagnostics: ports.diagnostics,
      primaryName: 'Demo',
    })

    ports.transcript.append({
      role: 'user',
      message: 'I met Captain Rivera near the old lighthouse yesterday evening.',
    })
    ports.transcript.append({
      role: 'assistant',
      message:
        'Captain Rivera remembers the coded lantern signals used by smugglers at midnight.',
    })

    const mvuBefore = JSON.stringify(ports.transcript.getMvu())
    await ports.lifecycle.emit('afterGenerate', {
      raw: runtimeState.messages[1].message,
      messageId: 1,
    })
    expect(JSON.stringify(ports.transcript.getMvu())).toBe(mvuBefore)
    expect(mind.getStore().activeCount()).toBeGreaterThan(0)
    // transcript length unchanged by Mind
    expect(ports.transcript.getMessages()).toHaveLength(2)
    mind.dispose()
  })

  it('flag off: no mind service means no injection keys from Mind', async () => {
    // Simulate bootstrap when isMindEnabled() is false: do not create MindService.
    const { getRuntime } = runtimeBundle()
    const ports = createPorts({ getRuntime })
    await ports.lifecycle.emit('beforeGenerate', { userMessage: 'x' })
    await ports.lifecycle.emit('afterGenerate', { raw: 'y', messageId: 0 })
    expect(ports.promptInjection.list()).toHaveLength(0)
    expect(isMindEnabled({ localStorage: { getItem: () => null }, location: { search: '' } })).toBe(
      false,
    )
  })

  it('empty store: beforeGenerate does not set mind.primary injection', async () => {
    const { getRuntime } = runtimeBundle()
    const ports = createPorts({ getRuntime })
    const mind = createMindService({
      transcript: ports.transcript,
      promptInjection: ports.promptInjection,
      lifecycle: ports.lifecycle,
      diagnostics: ports.diagnostics,
      primaryName: 'Demo',
    })
    // Stale key from a prior turn must be cleared when store is empty.
    ports.promptInjection.set('mind.primary', {
      content: 'stale',
      source: 'mind',
      position: 'after_scenario',
    })
    await ports.lifecycle.emit('beforeGenerate', { userMessage: 'hi' })
    expect(ports.promptInjection.list()).toHaveLength(0)
    expect(mind.getLastInjection()).toBeNull()
    mind.dispose()
  })

  it('sessionTeardown clears memories so next beforeGenerate has no stale injection', async () => {
    const { getRuntime } = runtimeBundle()
    const ports = createPorts({ getRuntime })
    const mind = createMindService({
      transcript: ports.transcript,
      promptInjection: ports.promptInjection,
      lifecycle: ports.lifecycle,
      diagnostics: ports.diagnostics,
      primaryName: 'CardA',
    })
    mind.getStore().insertMany([
      {
        npcId: 'primary',
        text: 'Secret from card A that must not leak to card B.',
        labels: ['knowledge/unspecified'],
        scores: { knowledge: 0.9 },
      },
    ])
    await ports.lifecycle.emit('beforeGenerate', { userMessage: 'a' })
    expect(ports.promptInjection.list()).toHaveLength(1)
    expect(ports.promptInjection.list()[0].content).toContain('Secret from card A')

    await ports.lifecycle.emit('sessionTeardown', { cardName: 'CardA', toIdle: false })
    expect(mind.getStore().activeCount()).toBe(0)
    expect(mind.getLastInjection()).toBeNull()
    expect(ports.promptInjection.list().find((i) => i.key === 'mind.primary')).toBeUndefined()

    await ports.lifecycle.emit('sessionReady', { cardName: 'CardB' })
    expect(mind.getPrimaryNpc().displayName).toBe('CardB')
    await ports.lifecycle.emit('beforeGenerate', { userMessage: 'b' })
    expect(ports.promptInjection.list()).toHaveLength(0)
    expect(mind.getLastInjection()).toBeNull()
    mind.dispose()
  })
})

describe('Kernel + Mind integration (accept path)', () => {
  function createMinimalRuntime(openingText = 'Opening') {
    return {
      runtimeState: {
        mvuData: { stat_data: { turn: 0 } },
        messages: [
          {
            message_id: 0,
            role: 'assistant',
            name: 'assistant',
            is_hidden: false,
            message: openingText,
            data: { stat_data: { turn: 0 } },
            extra: {},
            swipe_id: 0,
            swipes: [openingText],
            rendered_swipes: [`<p>${openingText}</p>`],
            swipes_data: [{ stat_data: { turn: 0 } }],
            swipes_info: [{}],
          },
        ],
      },
    }
  }

  it('sendUserMessage: lastInjection content equals request + prompt_debug mind injection', async () => {
    const store = createSessionStore()
    store.setRuntime(createMinimalRuntime())
    store.setPhase('running')

    const ports = createPorts({ getRuntime: () => store.getRuntime() })
    const mind = createMindService({
      transcript: ports.transcript,
      promptInjection: ports.promptInjection,
      lifecycle: ports.lifecycle,
      diagnostics: ports.diagnostics,
      primaryName: 'Demo',
    })
    mind.getStore().insertMany([
      {
        npcId: 'primary',
        text: 'User likes tea in the morning at the inn.',
        labels: ['knowledge/unspecified'],
        scores: { knowledge: 0.7 },
      },
    ])

    /** @type {object|null} */
    let capturedBody = null
    const chatApi = async (body) => {
      capturedBody = body
      return {
        raw_text: 'Assistant reply about tea.',
        rendered_html: '<p>Assistant reply about tea.</p>',
        new_state: { stat_data: { turn: 1 } },
        prompt_debug: {
          base_prompt: 'base',
          final_prompt: `base\n${(body.injections || []).map((i) => i.content).join('\n')}`,
          injections: body.injections || [],
        },
      }
    }

    const kernel = createSessionKernel({
      store,
      shell: { setDiagnostics: () => {} },
      createRuntime: () => createMinimalRuntime(),
      lifecycle: ports.lifecycle,
      ports,
      chatApi,
      hooks: {
        renderAssistantDisplay: (raw) => raw,
      },
    })

    const data = await kernel.sendUserMessage('hello mind')
    expect(capturedBody).toBeTruthy()
    const mindInj = (capturedBody.injections || []).find(
      (i) => i.source === 'mind' || i.key === 'mind.primary',
    )
    expect(mindInj).toBeTruthy()
    expect(mind.getLastInjection()?.content).toBe(mindInj.content)
    expect(mindInj.content).toContain('[Conclave Mind — primary NPC: Demo]')
    expect(mindInj.content).toContain('User likes tea')

    // Round-trip: mock API echoes injections into prompt_debug (backend contract).
    const debugMind = (data.prompt_debug?.injections || []).find(
      (i) => i.source === 'mind' || i.key === 'mind.primary',
    )
    expect(debugMind?.content).toBe(mind.getLastInjection()?.content)
    expect(data.prompt_debug?.final_prompt).toContain('Conclave Mind')

    mind.dispose()
  })
})
