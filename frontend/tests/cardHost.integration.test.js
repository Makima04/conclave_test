/**
 * Multi-card Host integration (L3):
 *   load card A → MessageMount opening → mock chat N rounds
 *   → load card B → teardown residuals cleared
 *
 * Uses synthetic fixtures + SessionKernel; does not start a browser.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSessionStore } from '../src/session/SessionStore.js'
import { createSessionKernel } from '../src/session/SessionKernel.js'
import { createPorts } from '../src/bridge/createPorts.js'
import { createMessageMount } from '../src/st-host/render/MessageMount.js'
import { processDisplay } from '../src/st-host/render/RenderPipeline.js'
import { loadCardJson, buildInitLikePayload } from '../../fixtures/helpers/loadCard.mjs'
import { createDomRoot, installDocumentStub } from './helpers/domStub.js'

/**
 * @param {import('../src/session/SessionStore.js').SessionStore} store
 */
function makeCreateRuntime(store) {
  return () => {
    const openings = store.getOpeningRawMessages()
    const raw0 = openings[0] || 'Opening'
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

describe('multi-card Host integration', () => {
  beforeEach(() => {
    installDocumentStub(vi)
  })

  it('A → mock chat → B: opening, bubble counts, epoch, no residual nodes', async () => {
    const cardA = loadCardJson('regex-basic')
    const cardB = loadCardJson('status-bar')

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

    const teardowns = []
    let sessionEpoch = 0
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
          ...(client_mvu && typeof client_mvu === 'object' ? client_mvu : {}),
          stat_data: {
            ...((client_mvu && client_mvu.stat_data) || {}),
            last: user_message,
          },
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
            rt._artifactNodes = rt._artifactNodes || []
            rt._artifactNodes.push({ id: `art-${store.getCardName()}` })
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
          teardowns.push(store.getCardName() || '?')
          messageMount.teardown()
        },
        renderAssistantDisplay: (raw) => {
          // Chat turns: display pipeline with current card scripts
          return processDisplay(String(raw ?? ''), store.getRegexScripts() || [])
        },
        onLeaveOpeningForChat: () => {
          messageMount.renderAll()
        },
      },
    })

    async function loadCard(card, importId) {
      sessionEpoch += 1
      if (!imported.find((x) => x.id === importId)) {
        imported.push({
          id: importId,
          name: card.name,
          entry_count: 0,
          source_file: null,
        })
      }
      const payload = buildInitLikePayload(card, {
        sessionEpoch,
        importId,
        imported: [...imported],
      })
      await kernel.loadFromInitResponse(payload)
    }

    // --- Card A: regex-basic ---
    await loadCard(cardA, 0)
    expect(store.getPhase()).toBe('running')
    expect(store.getCardName()).toBe('Regex Basic')
    expect(store.getSessionEpoch()).toBe(1)

    const openingA = root.children[0]
    expect(openingA).toBeTruthy()
    const openingAHtml = openingA.innerHTML || openingA.textContent || ''
    expect(openingAHtml).toContain('panel')
    expect(openingAHtml).toContain('角色开场')

    // Mock chat 2 rounds
    await kernel.sendUserMessage('ping-1')
    await kernel.sendUserMessage('ping-2')
    const msgsAfterChat = store.getMessages()
    // opening + 2 user + 2 assistant = 5
    expect(msgsAfterChat.length).toBe(5)
    expect(root.children.length).toBe(5)
    expect(msgsAfterChat[msgsAfterChat.length - 1].role).toBe('assistant')
    expect(msgsAfterChat[msgsAfterChat.length - 1].message).toContain('ping-2')

    // Artifact marker from beginCardArtifactTracking
    expect(store.getRuntime()._artifactNodes.length).toBeGreaterThan(0)

    // --- Card B: status-bar ---
    await loadCard(cardB, 1)
    expect(teardowns.length).toBeGreaterThanOrEqual(1)
    expect(store.getPhase()).toBe('running')
    expect(store.getCardName()).toBe('Status Bar Demo')
    expect(store.getSessionEpoch()).toBe(2)

    // Messages reset to opening only
    const msgsB = store.getRuntime().runtimeState.messages
    expect(msgsB.length).toBe(1)
    expect(root.children.length).toBe(1)
    const openingBHtml = root.children[0].innerHTML || root.children[0].textContent || ''
    expect(openingBHtml).toContain('status-card')
    // No residual panel from card A
    expect(openingBHtml).not.toContain('角色开场')
    expect(openingBHtml).not.toMatch(/class="panel"/)

    // Fresh artifact list for B (A cleaned)
    expect(store.getRuntime()._artifactNodes).toEqual([{ id: 'art-Status Bar Demo' }])

    // Swipe to alternate greeting (no status) via Session + refresh
    const msg0 = msgsB[0]
    msg0.swipe_id = 1
    if (!msg0.rendered_swipes[1]) {
      msg0.rendered_swipes[1] = processDisplay(msg0.swipes[1], store.getRegexScripts())
    }
    messageMount.refresh(0)
    const swipeHtml = root.children[0].innerHTML || root.children[0].textContent || ''
    expect(swipeHtml).toContain('右滑')
    expect(swipeHtml).not.toContain('status-card')
  })

  it('neutral card never injects 灵石 defaults into opening display or mvu shell', async () => {
    const card = loadCardJson('minimal-neutral')
    const store = createSessionStore()
    const root = createDomRoot()
    const messageMount = createMessageMount({
      getRoot: () => root,
      getMessages: () => store.getMessages(),
      renderHtmlInto: (html, el) => {
        el.innerHTML = html || ''
      },
    })
    messageMount.bind(root)

    const kernel = createSessionKernel({
      store,
      shell: {},
      createRuntime: makeCreateRuntime(store),
      messageMount,
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
      },
    })

    const payload = buildInitLikePayload(card, { sessionEpoch: 1, importId: 0 })
    await kernel.loadFromInitResponse(payload)

    const html = root.children[0]?.innerHTML || root.children[0]?.textContent || ''
    expect(html).toContain('neutral demo')
    expect(html).not.toMatch(/灵石|主角状态|世界系统/)
    const mvu = store.getRuntime().runtimeState.mvuData
    const serialized = JSON.stringify(mvu)
    expect(serialized).not.toMatch(/灵石|世界系统/)
  })
})
