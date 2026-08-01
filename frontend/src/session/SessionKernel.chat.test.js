/**
 * PR-07: Chat sync — Session-first sendUserMessage eliminates triple drift.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSessionStore } from './SessionStore.js'
import { createSessionKernel } from './SessionKernel.js'
import { createPorts } from '../bridge/createPorts.js'
import { createMessageMount } from '../st-host/render/MessageMount.js'

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

/** Minimal DOM root for MessageMount in node env. */
function createDomRoot() {
  const children = []
  const root = {
    children,
    appendChild(n) {
      children.push(n)
      n.parentNode = root
      n.isConnected = true
      n.remove = () => {
        const i = children.indexOf(n)
        if (i >= 0) children.splice(i, 1)
        n.isConnected = false
        n.parentNode = null
      }
    },
    insertBefore(n, ref) {
      const i = children.indexOf(ref)
      if (i >= 0) children.splice(i, 0, n)
      else children.push(n)
      n.parentNode = root
      n.isConnected = true
      n.remove = () => {
        const idx = children.indexOf(n)
        if (idx >= 0) children.splice(idx, 1)
        n.isConnected = false
        n.parentNode = null
      }
    },
    get innerHTML() {
      return children.map((c) => c.innerHTML || c.textContent || '').join('')
    },
    set innerHTML(v) {
      if (v === '') {
        children.length = 0
      }
    },
  }
  return root
}

function installDocumentStub() {
  vi.stubGlobal('document', {
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        className: '',
        dataset: {},
        textContent: '',
        innerHTML: '',
        isConnected: false,
        parentNode: null,
        remove() {
          this.isConnected = false
        },
      }
    },
  })
}

describe('PR-07 SessionKernel.sendUserMessage chat sync', () => {
  beforeEach(() => {
    installDocumentStub()
  })

  it('after N=3 rounds: messages.length, visible bubbles, and latest assistant agree; mvu applies new_state', async () => {
    const store = createSessionStore()
    store.setRuntime(createMinimalRuntime())
    store.setPhase('running')

    const ports = createPorts({ getRuntime: () => store.getRuntime() })
    const root = createDomRoot()
    const messageMount = createMessageMount({
      getRoot: () => root,
      getMessages: () => store.getMessages(),
      renderHtmlInto: (html, el) => {
        el.innerHTML = html
      },
    })
    messageMount.bind(root)
    messageMount.refresh(0)

    let turn = 0
    const chatApi = vi.fn(async (body) => {
      turn += 1
      expect(body.user_message).toBeTruthy()
      expect(body.client_mvu).toBeDefined()
      expect(body).toHaveProperty('session_id')
      expect(Array.isArray(body.injections)).toBe(true)
      return {
        raw_text: `Assistant reply ${turn}`,
        rendered_html: `<p>Assistant reply ${turn}</p>`,
        new_state: {
          stat_data: { turn, last_user: body.user_message },
        },
        prompt_debug: {
          base_prompt: 'base',
          final_prompt: 'base',
          injections: body.injections,
        },
      }
    })

    const beforeGenerate = vi.fn()
    const afterGenerate = vi.fn()
    ports.lifecycle.on('beforeGenerate', beforeGenerate)
    ports.lifecycle.on('afterGenerate', afterGenerate)

    const kernel = createSessionKernel({
      store,
      shell: { setDiagnostics: () => {} },
      createRuntime: () => createMinimalRuntime(),
      lifecycle: ports.lifecycle,
      ports,
      messageMount,
      chatApi,
      hooks: {
        renderAssistantDisplay: (raw, hint) => hint || raw,
        onLeaveOpeningForChat: () => {
          messageMount.renderAll()
        },
      },
    })

    const N = 3
    for (let i = 1; i <= N; i += 1) {
      await kernel.sendUserMessage(`user turn ${i}`)
    }

    // 1 opening + N user + N assistant
    const messages = store.getMessages()
    expect(messages.length).toBe(1 + N * 2)

    // Visible bubbles == Session messages
    expect(root.children.length).toBe(messages.length)
    expect(messageMount.getNode(0)?.className).toBe('st-assistant-message')
    expect(messageMount.getNode(1)?.className).toBe('st-user-message')
    expect(messageMount.getNode(messages.length - 1)?.className).toBe('st-assistant-message')

    // getChatMessages('latest') semantics: last message is last assistant
    const latestId = messages.length - 1
    const latest = messages[latestId]
    expect(latest.role).toBe('assistant')
    expect(latest.message).toBe('Assistant reply 3')

    // mvu matches last new_state
    expect(store.getMvu()).toEqual({
      stat_data: { turn: 3, last_user: 'user turn 3' },
    })
    expect(latest.data).toEqual(store.getMvu())

    // client_mvu was uploaded each turn (base from Session)
    expect(chatApi).toHaveBeenCalledTimes(N)
    const lastBody = chatApi.mock.calls[N - 1][0]
    // After turn 2, mvu had turn:2 before turn 3 request
    expect(lastBody.client_mvu.stat_data.turn).toBe(2)

    expect(beforeGenerate).toHaveBeenCalledTimes(N)
    expect(afterGenerate).toHaveBeenCalledTimes(N)
    expect(afterGenerate.mock.calls[N - 1][0].messageId).toBe(latestId)
  })

  it('appends user to Session BEFORE chatApi is invoked', async () => {
    const store = createSessionStore()
    store.setRuntime(createMinimalRuntime())
    store.setPhase('running')
    const ports = createPorts({ getRuntime: () => store.getRuntime() })

    let lengthWhenFetched = -1
    const chatApi = vi.fn(async () => {
      lengthWhenFetched = store.getMessages().length
      return {
        raw_text: 'ok',
        new_state: { stat_data: {} },
      }
    })

    const kernel = createSessionKernel({
      store,
      shell: {},
      createRuntime: () => createMinimalRuntime(),
      ports,
      chatApi,
      hooks: {},
    })

    expect(store.getMessages().length).toBe(1)
    await kernel.sendUserMessage('hello first')
    // user already present when network ran (opening + user)
    expect(lengthWhenFetched).toBe(2)
    // after full turn: opening + user + assistant
    expect(store.getMessages().length).toBe(3)
  })

  it('rejects empty message without touching transcript', async () => {
    const store = createSessionStore()
    store.setRuntime(createMinimalRuntime())
    const ports = createPorts({ getRuntime: () => store.getRuntime() })
    const chatApi = vi.fn()
    const kernel = createSessionKernel({
      store,
      shell: {},
      createRuntime: () => createMinimalRuntime(),
      ports,
      chatApi,
      hooks: {},
    })
    const result = await kernel.sendUserMessage('   ')
    expect(result).toBeNull()
    expect(chatApi).not.toHaveBeenCalled()
    expect(store.getMessages().length).toBe(1)
  })

  it('on chatApi rejection: keeps user, leaves mvu, no assistant, DOM matches Session', async () => {
    const store = createSessionStore()
    store.setRuntime(createMinimalRuntime())
    store.setPhase('running')
    const ports = createPorts({ getRuntime: () => store.getRuntime() })
    const root = createDomRoot()
    const messageMount = createMessageMount({
      getRoot: () => root,
      getMessages: () => store.getMessages(),
      renderHtmlInto: (html, el) => {
        el.innerHTML = html
      },
    })
    messageMount.bind(root)
    messageMount.refresh(0)

    const priorMvu = { ...store.getMvu() }
    const onSendError = vi.fn()
    const chatApi = vi.fn(async () => {
      throw new Error('network down')
    })

    const kernel = createSessionKernel({
      store,
      shell: {},
      createRuntime: () => createMinimalRuntime(),
      ports,
      messageMount,
      chatApi,
      hooks: {
        onSendError,
        onLeaveOpeningForChat: () => {
          messageMount.renderAll()
        },
      },
    })

    await expect(kernel.sendUserMessage('will fail')).rejects.toThrow(/network down/)

    const messages = store.getMessages()
    // opening + user only — no assistant
    expect(messages).toHaveLength(2)
    expect(messages[1].role).toBe('user')
    expect(messages[1].message).toBe('will fail')
    expect(store.getMvu()).toEqual(priorMvu)
    expect(onSendError).toHaveBeenCalledTimes(1)
    // After failure, renderAll re-projects Session → bubble count matches
    expect(root.children.length).toBe(messages.length)
    // No untracked error class nodes
    expect(root.children.every((c) => !String(c.className || '').includes('st-error'))).toBe(true)
  })

  it('missing new_state preserves prior mvu and still appends assistant', async () => {
    const store = createSessionStore()
    store.setRuntime(createMinimalRuntime())
    store.setPhase('running')
    const ports = createPorts({ getRuntime: () => store.getRuntime() })
    const prior = store.getMvu()

    const chatApi = vi.fn(async () => ({
      raw_text: 'reply without state',
      // new_state intentionally omitted
    }))

    const kernel = createSessionKernel({
      store,
      shell: {},
      createRuntime: () => createMinimalRuntime(),
      ports,
      chatApi,
      hooks: {},
    })

    await kernel.sendUserMessage('hi')
    expect(store.getMessages()).toHaveLength(3)
    expect(store.getMessages().at(-1).role).toBe('assistant')
    expect(store.getMessages().at(-1).message).toBe('reply without state')
    expect(store.getMvu()).toEqual(prior)
    expect(store.getMessages().at(-1).data).toEqual(prior)
  })

  it('array new_state is treated as invalid and does not wipe mvu', async () => {
    const store = createSessionStore()
    store.setRuntime(createMinimalRuntime())
    const ports = createPorts({ getRuntime: () => store.getRuntime() })
    const prior = store.getMvu()

    const kernel = createSessionKernel({
      store,
      shell: {},
      createRuntime: () => createMinimalRuntime(),
      ports,
      chatApi: async () => ({
        raw_text: 'x',
        new_state: [1, 2, 3],
      }),
      hooks: {},
    })

    await kernel.sendUserMessage('arr')
    expect(store.getMvu()).toEqual(prior)
  })

  it('sending guard blocks concurrent double-send', async () => {
    const store = createSessionStore()
    store.setRuntime(createMinimalRuntime())
    const ports = createPorts({ getRuntime: () => store.getRuntime() })

    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const chatApi = vi.fn(async () => {
      await gate
      return { raw_text: 'done', new_state: { stat_data: { turn: 1 } } }
    })

    const kernel = createSessionKernel({
      store,
      shell: {},
      createRuntime: () => createMinimalRuntime(),
      ports,
      chatApi,
      hooks: {},
    })

    const first = kernel.sendUserMessage('one')
    const second = await kernel.sendUserMessage('two')
    expect(second).toBeNull()
    release()
    await first
    expect(chatApi).toHaveBeenCalledTimes(1)
    // only one user turn
    expect(store.getMessages().filter((m) => m.role === 'user')).toHaveLength(1)
  })

  it('without onLeaveOpeningForChat, refresh-only path still mounts user+assistant', async () => {
    const store = createSessionStore()
    store.setRuntime(createMinimalRuntime())
    const ports = createPorts({ getRuntime: () => store.getRuntime() })
    const root = createDomRoot()
    const messageMount = createMessageMount({
      getRoot: () => root,
      getMessages: () => store.getMessages(),
      renderHtmlInto: (html, el) => {
        el.innerHTML = html
      },
    })
    messageMount.bind(root)
    messageMount.refresh(0)

    const kernel = createSessionKernel({
      store,
      shell: {},
      createRuntime: () => createMinimalRuntime(),
      ports,
      messageMount,
      chatApi: async () => ({
        raw_text: 'ok',
        new_state: { stat_data: { t: 1 } },
      }),
      hooks: {
        // deliberately no onLeaveOpeningForChat
      },
    })

    await kernel.sendUserMessage('ping')
    expect(store.getMessages()).toHaveLength(3)
    expect(messageMount.getNode(1)?.className).toBe('st-user-message')
    expect(messageMount.getNode(2)?.className).toBe('st-assistant-message')
  })
})

describe('SessionStore message/mvu helpers (PR-07)', () => {
  it('getMessages / appendMessage / replaceMvu stay coherent', () => {
    const store = createSessionStore()
    store.setRuntime(createMinimalRuntime())
    expect(store.getMessages()).toHaveLength(1)
    expect(store.getMvu()).toEqual({ stat_data: { turn: 0 } })

    store.appendMessage({ role: 'user', message: 'hi' })
    store.appendMessage({ role: 'assistant', message: 'yo', data: { a: 1 } })
    store.replaceMvu({ stat_data: { turn: 9 } }, 'test')
    expect(store.getMvu()).toEqual({ stat_data: { turn: 9 } })
    expect(store.getMessages().at(-1).data).toEqual({ stat_data: { turn: 9 } })
  })
})
