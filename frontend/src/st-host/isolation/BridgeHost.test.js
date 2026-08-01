import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBridgeHost } from './BridgeHost.js'
import { createRequest, createResponse, validateRequest } from './BridgeProtocol.js'
import { createEventBus } from '../context/EventBus.js'
import { buildBridgeClientSource } from './bridgeClientSource.js'
import { TH_CALL_METHODS } from './BridgeProtocol.js'
import { buildCardSrcdoc, resolveSandboxAttribute } from './CardFrame.js'

function makeStorage() {
  const ls = new Map()
  const fakeLocalStorage = {
    get length() {
      return ls.size
    },
    key(i) {
      return [...ls.keys()][i] ?? null
    },
    getItem(k) {
      return ls.has(k) ? ls.get(k) : null
    },
    setItem(k, v) {
      ls.set(String(k), String(v))
    },
    removeItem(k) {
      ls.delete(k)
    },
  }
  return { ls, fakeLocalStorage }
}

describe('BridgeHost dispatch', () => {
  /** @type {Map<string, string>} */
  let ls
  /** @type {ReturnType<typeof createBridgeHost>} */
  let host
  let th

  beforeEach(() => {
    const store = makeStorage()
    ls = store.ls
    vi.stubGlobal('localStorage', store.fakeLocalStorage)
    vi.stubGlobal('window', {
      localStorage: store.fakeLocalStorage,
      addEventListener() {},
      removeEventListener() {},
    })

    th = {
      getChatMessages: vi.fn(async (range) => [{ message_id: 0, range: range }]),
      getCurrentMessageId: vi.fn(() => 0),
      getVariables: vi.fn(() => ({ a: 1 })),
      replaceVariables: vi.fn(),
      updateVariablesWith: vi.fn((updater) => updater({ a: 1 })),
    }
    const mvu = {
      getMvuData: vi.fn(() => ({ stat_data: {} })),
      events: { VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' },
    }
    // requireFrameSource false for pure _dispatch unit tests without a frame.
    host = createBridgeHost({
      getSessionId: () => 'sess-1',
      getStorageNamespace: () => 'conclave:session:sess-1:card:1:',
      getSurfaces: () => ({ tavernHelper: th, mvu }),
      getEventBus: () => null,
      getFrameWindow: () => null,
      requireFrameSource: false,
      targetWindow: {
        addEventListener() {},
        removeEventListener() {},
      },
      log: () => {},
    })
  })

  afterEach(() => {
    host?.teardown()
    vi.unstubAllGlobals()
  })

  it('dispatches th.call getChatMessages', async () => {
    const result = await host._dispatch(
      createRequest({
        id: '1',
        sessionId: 'sess-1',
        type: 'th.call',
        method: 'getChatMessages',
        args: ['latest'],
      }),
    )
    expect(result).toEqual([{ message_id: 0, range: 'latest' }])
  })

  it('dispatches mvu.call events read', async () => {
    const result = await host._dispatch(
      createRequest({
        id: '2',
        sessionId: 'sess-1',
        type: 'mvu.call',
        method: 'events',
        args: [],
      }),
    )
    expect(result.VARIABLE_UPDATE_ENDED).toBe('mag_variable_update_ended')
  })

  it('storage get/set is namespaced', async () => {
    await host._dispatch(
      createRequest({
        id: '3',
        sessionId: 'sess-1',
        type: 'storage',
        method: 'setItem',
        args: ['foo', 'bar'],
      }),
    )
    const got = await host._dispatch(
      createRequest({
        id: '4',
        sessionId: 'sess-1',
        type: 'storage',
        method: 'getItem',
        args: ['foo'],
      }),
    )
    expect(got).toBe('bar')
    expect(
      [...ls.keys()].some((k) => k.includes('localStorage:foo') && k.includes('sess-1')),
    ).toBe(true)
  })

  it('rejects mount from frame (parent→frame only)', async () => {
    await expect(
      host._dispatch(
        createRequest({
          id: '5',
          sessionId: 'sess-1',
          type: 'mount',
          method: 'setHtml',
          args: ['<div/>'],
        }),
      ),
    ).rejects.toThrow(/parent→frame/)
  })

  it('rejects updateVariablesWith without a function (non-serializable path)', async () => {
    await expect(
      host._dispatch(
        createRequest({
          id: '6',
          sessionId: 'sess-1',
          type: 'th.call',
          method: 'updateVariablesWith',
          args: [{ not: 'a function' }, { type: 'chat' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'non_serializable_updater' })
  })

  it('does not fall back to globalThis without allowGlobalFallback', async () => {
    vi.stubGlobal('orphanMethod', () => 'from-global')
    // Surface lacks orphanMethod
    await expect(
      host._dispatch(
        createRequest({
          id: '7',
          sessionId: 'sess-1',
          type: 'th.call',
          method: 'getChatMessages',
          args: [],
        }),
      ),
    ).resolves.toBeTruthy()

    await expect(
      host._dispatch(
        createRequest({
          id: '8',
          sessionId: 'sess-1',
          type: 'th.call',
          method: 'triggerSlash',
          args: ['/echo'],
        }),
      ),
    ).rejects.toMatchObject({ code: 'method_unavailable' })
  })

  it('validateRequest + createResponse error code method_not_allowed', () => {
    const bad = createRequest({
      id: 'x',
      sessionId: 's',
      type: 'th.call',
      method: '__proto__',
      args: [],
    })
    const v = validateRequest(bad)
    expect(v.ok).toBe(false)
    const res = createResponse({ id: 'x', ok: false, error: v.error })
    expect(res.error.code).toBe('method_not_allowed')
  })
})

describe('BridgeHost handleMessage source/session/remount', () => {
  /** @type {ReturnType<typeof createBridgeHost>} */
  let host
  /** @type {{ postMessage: ReturnType<typeof vi.fn> }} */
  let frameWin
  let eventBus

  beforeEach(() => {
    const store = makeStorage()
    vi.stubGlobal('localStorage', store.fakeLocalStorage)
    vi.stubGlobal('window', {
      localStorage: store.fakeLocalStorage,
      addEventListener() {},
      removeEventListener() {},
    })

    frameWin = { postMessage: vi.fn() }
    eventBus = createEventBus()

    const th = {
      getChatMessages: vi.fn(async () => [{ message_id: 0 }]),
    }

    host = createBridgeHost({
      getSessionId: () => 'sess-1',
      getStorageNamespace: () => 'conclave:session:sess-1:card:1:',
      getSurfaces: () => ({ tavernHelper: th, mvu: { events: {} } }),
      getEventBus: () => eventBus,
      getFrameWindow: () => frameWin,
      requireFrameSource: true,
      targetWindow: {
        addEventListener() {},
        removeEventListener() {},
      },
      log: () => {},
    })
  })

  afterEach(() => {
    host?.teardown()
    vi.unstubAllGlobals()
  })

  it('ignores session mismatch', async () => {
    const replies = []
    await host._handleMessage({
      data: createRequest({
        id: 's',
        sessionId: 'other-session',
        type: 'th.call',
        method: 'getChatMessages',
        args: [],
      }),
      source: frameWin,
      origin: 'null',
    })
    expect(replies.length).toBe(0)
    expect(frameWin.postMessage).not.toHaveBeenCalled()
  })

  it('rejects wrong event.source', async () => {
    const other = { postMessage: vi.fn() }
    await host._handleMessage({
      data: createRequest({
        id: 'w',
        sessionId: 'sess-1',
        type: 'th.call',
        method: 'getChatMessages',
        args: [],
      }),
      source: other,
      origin: 'null',
    })
    expect(other.postMessage).not.toHaveBeenCalled()
    expect(frameWin.postMessage).not.toHaveBeenCalled()
  })

  it('rejects when event.source is null even if frame is bound', async () => {
    await host._handleMessage({
      data: createRequest({
        id: 'n',
        sessionId: 'sess-1',
        type: 'th.call',
        method: 'getChatMessages',
        args: [],
      }),
      source: null,
      origin: 'null',
    })
    expect(frameWin.postMessage).not.toHaveBeenCalled()
  })

  it('replies for valid source+session', async () => {
    await host._handleMessage({
      data: createRequest({
        id: 'ok1',
        sessionId: 'sess-1',
        type: 'th.call',
        method: 'getChatMessages',
        args: ['latest'],
      }),
      source: frameWin,
      origin: 'null',
    })
    expect(frameWin.postMessage).toHaveBeenCalled()
    const envelope = frameWin.postMessage.mock.calls[0][0]
    expect(envelope.ok).toBe(true)
    expect(envelope.id).toBe('ok1')
  })

  it('resetFrameListeners clears event subscriptions (remount leak fix)', async () => {
    await host._dispatch(
      createRequest({
        id: 'e1',
        sessionId: 'sess-1',
        type: 'event.on',
        args: ['mag_variable_update_ended', 'L1'],
      }),
    )
    expect(host.getListenerCount()).toBe(1)

    host.resetFrameListeners()
    expect(host.getListenerCount()).toBe(0)
    expect(host.getFrameGeneration()).toBeGreaterThan(0)

    // Emitting after reset must not post event.cb to frame
    frameWin.postMessage.mockClear()
    await eventBus.emit('mag_variable_update_ended', { x: 1 })
    expect(frameWin.postMessage).not.toHaveBeenCalled()
  })

  it('ignores non-bridge noise', async () => {
    await host._handleMessage({
      data: { hello: 'world' },
      source: frameWin,
      origin: 'null',
    })
    expect(frameWin.postMessage).not.toHaveBeenCalled()
  })
})

describe('bridge client source generation', () => {
  it('embeds TH_CALL_METHODS from BridgeProtocol (no drift)', () => {
    const src = buildBridgeClientSource({ sessionId: 's', parentOrigin: 'http://localhost' })
    for (const name of TH_CALL_METHODS) {
      expect(src).toContain(name)
    }
    expect(src).toContain('updateVariablesWith')
    expect(src).toContain('getVariables')
    expect(src).toContain('replaceVariables')
    expect(src).toContain('PARENT_ORIGIN')
    expect(src).toContain('http://localhost')
  })
})

describe('CardFrame srcdoc / sandbox', () => {
  it('buildCardSrcdoc includes bridge client and body', () => {
    const html = buildCardSrcdoc({
      sessionId: 'sess',
      headHtml: '<style data-conclave-card-head="true">.x{}</style>',
      bodyHtml: '<div id="card">hi</div>',
      scripts: [],
      thScripts: [],
      parentOrigin: 'http://host.test',
    })
    expect(html).toContain('__conclaveBridgeReady')
    expect(html).toContain('<div id="card">hi</div>')
    expect(html).toContain('.x{}')
    expect(html).toContain('http://host.test')
  })

  it('resolveSandboxAttribute defaults to allow-scripts only', () => {
    expect(resolveSandboxAttribute(false)).toBe('allow-scripts')
    expect(resolveSandboxAttribute(true)).toBe('allow-scripts allow-same-origin')
  })
})
