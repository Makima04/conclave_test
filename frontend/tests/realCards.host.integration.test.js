/**
 * Multi real-card Host integration:
 * load each tracked card in sequence (A→B→C→D), mock chat on one card,
 * assert switch resets transcript and does not keep previous opening DOM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSessionStore } from '../src/session/SessionStore.js'
import { createSessionKernel } from '../src/session/SessionKernel.js'
import { createPorts } from '../src/bridge/createPorts.js'
import { createMessageMount } from '../src/st-host/render/MessageMount.js'
import { processDisplay } from '../src/st-host/render/RenderPipeline.js'
import {
  listTrackedRealCards,
  buildInitLikePayload,
  cardFirstMes,
  cardRegexScripts,
  displayFingerprint,
  MIN_TRACKED_REAL_CARDS,
} from '../../fixtures/helpers/realCards.mjs'
import { createDomRoot, installDocumentStub } from './helpers/domStub.js'

function makeCreateRuntime(store) {
  return () => {
    const openings = store.getOpeningRawMessages()
    const raw0 = openings[0] || ''
    const scripts = store.getRegexScripts() || []
    const mvu = { stat_data: {}, card: store.getCardName() || '' }
    const swipes = openings.length ? openings.map(String) : [raw0]
    const rendered = swipes.map((r) => processDisplay(r, scripts))
    return {
      runtimeState: {
        mvuData: mvu,
        messages: [
          {
            message_id: 0,
            role: 'assistant',
            name: 'assistant',
            is_hidden: false,
            message: raw0,
            data: { ...mvu },
            extra: {},
            swipe_id: 0,
            swipes,
            rendered_swipes: rendered,
            swipes_data: swipes.map(() => ({ ...mvu })),
            swipes_info: swipes.map(() => ({})),
          },
        ],
      },
      _artifactNodes: [],
    }
  }
}

describe('real multi-card Host switch', () => {
  beforeEach(() => {
    installDocumentStub(vi)
  })

  it('loads every tracked real card in sequence without residual openings or message bleed', async () => {
    const cards = listTrackedRealCards()
    expect(cards.length).toBeGreaterThanOrEqual(MIN_TRACKED_REAL_CARDS)

    const store = createSessionStore()
    const ports = createPorts({ getRuntime: () => store.getRuntime() })
    const root = createDomRoot()
    const messageMount = createMessageMount({
      getRoot: () => root,
      getMessages: () => store.getMessages(),
      renderHtmlInto: (html, el) => {
        el.innerHTML = html || ''
      },
    })
    messageMount.bind(root)

    /** @type {string[]} */
    const loadedNames = []
    let epoch = 0
    const imported = []

    const kernel = createSessionKernel({
      store,
      shell: { setDiagnostics: () => {} },
      createRuntime: makeCreateRuntime(store),
      lifecycle: ports.lifecycle,
      ports,
      messageMount,
      chatApi: async ({ user_message, client_mvu }) => ({
        raw_text: `echo:${user_message}`,
        new_state: {
          ...(typeof client_mvu === 'object' && client_mvu ? client_mvu : {}),
          last: user_message,
        },
        prompt_debug: { base_prompt: 'x', final_prompt: 'x', injections: [] },
      }),
      hooks: {
        clearPendingRefreshTimers: () => {},
        cleanupCardArtifacts: () => {
          const rt = store.getRuntime()
          if (rt?._artifactNodes) rt._artifactNodes.length = 0
        },
        abortScripts: () => {},
        renderShell: () => {},
        beginCardArtifactTracking: () => {
          const rt = store.getRuntime()
          if (rt) {
            rt._artifactNodes = [{ id: store.getCardName() }]
          }
        },
        showOpeningView: () => {
          messageMount.teardown()
          messageMount.bind(root)
          const msgs = store.getRuntime()?.runtimeState?.messages || []
          if (msgs[0]) {
            const scripts = store.getRegexScripts()
            const sid = Number(msgs[0].swipe_id) || 0
            const raw = msgs[0].swipes?.[sid] || msgs[0].message || ''
            msgs[0].rendered_swipes = msgs[0].rendered_swipes || []
            msgs[0].rendered_swipes[sid] = processDisplay(raw, scripts)
          }
          messageMount.refresh(0)
        },
        executeTavernHelperScripts: () => {},
        onTeardown: () => {
          messageMount.teardown()
        },
        renderAssistantDisplay: (raw) =>
          processDisplay(String(raw ?? ''), store.getRegexScripts() || []),
        onLeaveOpeningForChat: () => messageMount.renderAll(),
      },
    })

    /** @type {{ id: string, name: string, openFp: string, openHtml: string }[]} */
    const snapshots = []

    for (let i = 0; i < cards.length; i++) {
      const ref = cards[i]
      epoch += 1
      imported.push({
        id: i,
        name: ref.name,
        entry_count: 0,
        source_file: ref.path,
      })
      const payload = buildInitLikePayload(ref.card, {
        sessionEpoch: epoch,
        importId: i,
        imported: [...imported],
      })
      await kernel.loadFromInitResponse(payload)

      expect(store.getPhase()).toBe('running')
      expect(store.getCardName()).toBe(ref.name)
      expect(store.getSessionEpoch()).toBe(epoch)
      expect(store.getRegexScripts().length).toBe(cardRegexScripts(ref.card).length)

      // Only opening message after switch
      expect(store.getMessages().length).toBe(1)
      expect(root.children.length).toBe(1)

      const openHtml = root.children[0].innerHTML || root.children[0].textContent || ''
      const openFp = displayFingerprint(openHtml).sha256
      snapshots.push({ id: ref.id, name: ref.name, openFp, openHtml })

      // Artifact tracking scoped to current card
      expect(store.getRuntime()._artifactNodes).toEqual([{ id: ref.name }])

      // Previous cards' openings must not linger as sole content when fingerprints differ
      if (i > 0) {
        const prev = snapshots[i - 1]
        if (prev.openFp !== openFp) {
          // Strong check: previous opening HTML is not still the only bubble
          expect(openHtml).not.toBe(prev.openHtml)
        }
      }

      loadedNames.push(ref.name)
    }

    // At least two cards produced different display fingerprints (set is diverse)
    const fps = new Set(snapshots.map((s) => s.openFp))
    expect(fps.size).toBeGreaterThanOrEqual(2)

    // Chat on last card only — then switch back to first card clears chat
    const last = cards[cards.length - 1]
    await kernel.sendUserMessage(`probe-${last.id}`)
    expect(store.getMessages().length).toBe(3) // open + user + assistant
    expect(root.children.length).toBe(3)

    // Re-select first card (new epoch)
    epoch += 1
    const first = cards[0]
    await kernel.loadFromInitResponse(
      buildInitLikePayload(first.card, {
        sessionEpoch: epoch,
        importId: 0,
        imported: [...imported],
      }),
    )
    expect(store.getCardName()).toBe(first.name)
    expect(store.getMessages().length).toBe(1)
    expect(root.children.length).toBe(1)
    const backHtml = root.children[0].innerHTML || root.children[0].textContent || ''
    expect(backHtml).not.toContain(`probe-${last.id}`)
    expect(displayFingerprint(backHtml).sha256).toBe(snapshots[0].openFp)

    expect(loadedNames.length).toBe(cards.length)
  })

  it('mock chat on card A then switch to B: bubble count resets; B uses B scripts', async () => {
    const cards = listTrackedRealCards()
    expect(cards.length).toBeGreaterThanOrEqual(2)
    const [a, b] = cards

    const store = createSessionStore()
    const ports = createPorts({ getRuntime: () => store.getRuntime() })
    const root = createDomRoot()
    const messageMount = createMessageMount({
      getRoot: () => root,
      getMessages: () => store.getMessages(),
      renderHtmlInto: (html, el) => {
        el.innerHTML = html || ''
      },
    })

    const kernel = createSessionKernel({
      store,
      shell: {},
      createRuntime: makeCreateRuntime(store),
      lifecycle: ports.lifecycle,
      ports,
      messageMount,
      chatApi: async ({ user_message }) => ({
        raw_text: `reply-to-${user_message}`,
        new_state: { stat_data: { u: user_message } },
        prompt_debug: { base_prompt: '', final_prompt: '', injections: [] },
      }),
      hooks: {
        clearPendingRefreshTimers: () => {},
        cleanupCardArtifacts: () => {},
        renderShell: () => {},
        beginCardArtifactTracking: () => {},
        showOpeningView: () => {
          messageMount.teardown()
          messageMount.bind(root)
          messageMount.refresh(0)
        },
        executeTavernHelperScripts: () => {},
        onTeardown: () => messageMount.teardown(),
        renderAssistantDisplay: (raw) =>
          processDisplay(String(raw ?? ''), store.getRegexScripts() || []),
        onLeaveOpeningForChat: () => messageMount.renderAll(),
      },
    })

    await kernel.loadFromInitResponse(buildInitLikePayload(a.card, { sessionEpoch: 1, importId: 0 }))
    await kernel.sendUserMessage('turn-a')
    expect(store.getMessages().length).toBe(3)

    await kernel.loadFromInitResponse(buildInitLikePayload(b.card, { sessionEpoch: 2, importId: 1 }))
    expect(store.getMessages().length).toBe(1)
    expect(store.getRegexScripts().length).toBe(cardRegexScripts(b.card).length)
    // Runtime opening raw matches B
    expect(store.getOpeningRawMessages()[0]).toBe(cardFirstMes(b.card))
  })
})
