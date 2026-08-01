/**
 * PR-11 Mind MVP tests: flag, extractor, dedupe, beforeGenerate injection.
 */
import { describe, it, expect } from 'vitest'
import { isMindEnabled, MIND_FEATURE_KEY } from './flags.js'
import {
  extractCandidates,
  looksLikeUiChrome,
  splitCandidateLines,
} from './RuleExtractor.js'
import { contentHash, normalizeText } from './dedupe.js'
import { createMemoryStore } from './MemoryStore.js'
import { composePrompt } from './promptCompose.js'
import { createMindService } from './MindService.js'
import { createPorts } from '../bridge/createPorts.js'

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

  it('splitCandidateLines breaks on newlines and periods', () => {
    const lines = splitCandidateLines('One line。Two line. Three')
    expect(lines.some((l) => l.includes('One'))).toBe(true)
    expect(lines.length).toBeGreaterThanOrEqual(2)
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
})
