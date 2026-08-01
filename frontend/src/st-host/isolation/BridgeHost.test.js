import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBridgeHost } from './BridgeHost.js'
import { createRequest, createResponse, validateRequest } from './BridgeProtocol.js'

describe('BridgeHost dispatch', () => {
  /** @type {Map<string, string>} */
  let ls
  /** @type {ReturnType<typeof createBridgeHost>} */
  let host
  let messages

  beforeEach(() => {
    ls = new Map()
    messages = []
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
    vi.stubGlobal('localStorage', fakeLocalStorage)
    vi.stubGlobal('window', {
      localStorage: fakeLocalStorage,
      addEventListener() {},
      removeEventListener() {},
    })

    const th = {
      getChatMessages: vi.fn(async (range) => [{ message_id: 0, range: range }]),
      getCurrentMessageId: vi.fn(() => 0),
    }
    const mvu = {
      getMvuData: vi.fn(() => ({ stat_data: {} })),
      events: { VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' },
    }
    host = createBridgeHost({
      getSessionId: () => 'sess-1',
      getStorageNamespace: () => 'conclave:session:sess-1:card:1:',
      getSurfaces: () => ({ tavernHelper: th, mvu }),
      getEventBus: () => null,
      getFrameWindow: () => null,
      targetWindow: {
        addEventListener() {},
        removeEventListener() {},
      },
      log: () => {},
    })
    // capture replies via _handleMessage source mock
    void messages
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
    // underlying key is namespaced
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
