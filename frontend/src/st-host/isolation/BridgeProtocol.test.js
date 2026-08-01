import { describe, it, expect } from 'vitest'
import {
  BRIDGE_PROTOCOL_VERSION,
  TH_CALL_METHODS,
  MVU_CALL_METHODS,
  STORAGE_METHODS,
  METHOD_ALLOWLIST,
  isMethodAllowed,
  isTypeAllowed,
  createRequest,
  createResponse,
  isBridgeRequest,
  isBridgeResponse,
  validateRequest,
  respondTo,
} from './BridgeProtocol.js'
import {
  isCardIframeEnabled,
  isIframeSameOriginEnabled,
  CARD_IFRAME_KEY,
  IFRAME_SAME_ORIGIN_KEY,
} from './flags.js'
import { resolveSandboxAttribute } from './CardFrame.js'
import { createIframeAdapter, createWindowAdapter } from './GlobalAdapter.js'

describe('BridgeProtocol v1 allowlist', () => {
  it('freezes th.call methods from architecture §5.3', () => {
    expect(TH_CALL_METHODS).toEqual([
      'getChatMessages',
      'setChatMessages',
      'setChatMessage',
      'getCurrentMessageId',
      'getVariables',
      'replaceVariables',
      'updateVariablesWith',
      'insertOrAssignVariables',
      'insertVariables',
      'deleteVariable',
      'getLorebookEntries',
      'setLorebookEntries',
      'triggerSlash',
      'formatAsTavernRegexedString',
    ])
    expect(Object.isFrozen(TH_CALL_METHODS)).toBe(true)
  })

  it('allows listed th/mvu/storage methods and rejects unknown', () => {
    expect(isMethodAllowed('th.call', 'getChatMessages')).toBe(true)
    expect(isMethodAllowed('th.call', 'eval')).toBe(false)
    expect(isMethodAllowed('mvu.call', 'getMvuData')).toBe(true)
    expect(isMethodAllowed('mvu.call', 'events')).toBe(true)
    expect(MVU_CALL_METHODS).toContain('parseMessage')
    expect(isMethodAllowed('storage', 'getItem')).toBe(true)
    expect(STORAGE_METHODS).toContain('clear')
    expect(isMethodAllowed('storage', 'openDatabase')).toBe(false)
    expect(isMethodAllowed('diag', 'log')).toBe(true)
    expect(isMethodAllowed('mount', 'setHtml')).toBe(true)
    expect(isMethodAllowed('not.a.type', 'x')).toBe(false)
  })

  it('treats event.* types as verb-only (no method field required)', () => {
    expect(isTypeAllowed('event.on')).toBe(true)
    expect(isTypeAllowed('event.off')).toBe(true)
    expect(isTypeAllowed('event.once')).toBe(true)
    expect(isTypeAllowed('event.emit')).toBe(true)
    expect(isTypeAllowed('event.cb')).toBe(true)
    expect(METHOD_ALLOWLIST['event.on']).toBe(null)
    expect(isMethodAllowed('event.on', undefined)).toBe(true)
    expect(isMethodAllowed('event.emit', 'anything')).toBe(true)
  })
})

describe('BridgeProtocol v1 envelope roundtrip', () => {
  it('createRequest / createResponse preserve v1 shape', () => {
    const req = createRequest({
      id: 'r1',
      sessionId: 's1',
      type: 'th.call',
      method: 'getChatMessages',
      args: ['latest'],
    })
    expect(req).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      id: 'r1',
      sessionId: 's1',
      type: 'th.call',
      method: 'getChatMessages',
      args: ['latest'],
    })
    expect(isBridgeRequest(req)).toBe(true)

    const ok = createResponse({ id: 'r1', ok: true, result: [{ message_id: 0 }] })
    expect(ok).toEqual({
      v: 1,
      id: 'r1',
      ok: true,
      result: [{ message_id: 0 }],
    })
    expect(isBridgeResponse(ok)).toBe(true)

    const err = createResponse({
      id: 'r1',
      ok: false,
      error: { message: 'nope', code: 'method_not_allowed' },
    })
    expect(err.ok).toBe(false)
    expect(err.error).toEqual({ message: 'nope', code: 'method_not_allowed' })
  })

  it('validateRequest accepts allowlisted and rejects unknown methods', () => {
    const good = createRequest({
      id: 'a',
      sessionId: 's',
      type: 'th.call',
      method: 'getChatMessages',
      args: [],
    })
    const vGood = validateRequest(good)
    expect(vGood.ok).toBe(true)

    const bad = createRequest({
      id: 'b',
      sessionId: 's',
      type: 'th.call',
      method: 'deleteEverything',
      args: [],
    })
    const vBad = validateRequest(bad)
    expect(vBad.ok).toBe(false)
    expect(vBad.error.code).toBe('method_not_allowed')

    const junk = validateRequest({ foo: 1 })
    expect(junk.ok).toBe(false)
    expect(junk.error.code).toBe('invalid_envelope')
  })

  it('respondTo roundtrips request id', () => {
    const req = createRequest({
      id: 'round',
      sessionId: 'sess',
      type: 'storage',
      method: 'getItem',
      args: ['k'],
    })
    const res = respondTo(req, { ok: true, result: 'v' })
    expect(res.id).toBe('round')
    expect(res.ok).toBe(true)
    expect(res.result).toBe('v')
    expect(res.v).toBe(1)
  })
})

describe('feature flags (card_iframe default off)', () => {
  it('isCardIframeEnabled defaults false; respects storage and query', () => {
    const store = new Map()
    const storage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    }
    expect(isCardIframeEnabled({ storage, search: '' })).toBe(false)
    storage.setItem(CARD_IFRAME_KEY, '1')
    expect(isCardIframeEnabled({ storage, search: '' })).toBe(true)
    store.clear()
    expect(isCardIframeEnabled({ storage, search: '?card_iframe=1' })).toBe(true)
    expect(isCardIframeEnabled({ storage, search: '?card_iframe=0' })).toBe(false)
  })

  it('iframe_same_origin flag and sandbox attribute', () => {
    const store = new Map()
    const storage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    }
    expect(isIframeSameOriginEnabled({ storage })).toBe(false)
    expect(resolveSandboxAttribute(false)).toBe('allow-scripts')
    expect(resolveSandboxAttribute(true)).toBe('allow-scripts allow-same-origin')
    storage.setItem(IFRAME_SAME_ORIGIN_KEY, '1')
    expect(isIframeSameOriginEnabled({ storage })).toBe(true)
  })
})

describe('IframeAdapter', () => {
  it('tracks defines in registry without target window', () => {
    const adapter = createIframeAdapter({ getTargetWindow: () => null })
    adapter.defineGlobal('TavernHelper', { getChatMessages: () => [] })
    adapter.defineGlobal('Mvu', { events: {} })
    expect(adapter.getDefined().get('TavernHelper')).toBeTruthy()
    expect(adapter.getDefined().has('Mvu')).toBe(true)
    adapter.teardown()
    expect(adapter.getDefined().size).toBe(0)
  })

  it('writes into target when available (same-origin path)', () => {
    const target = {}
    const adapter = createIframeAdapter({ getTargetWindow: () => target })
    adapter.defineGlobal('getChatMessages', () => [1])
    expect(typeof target.getChatMessages).toBe('function')
    expect(target.getChatMessages()).toEqual([1])
    adapter.teardown()
    expect(target.getChatMessages).toBeUndefined()
  })

  it('WindowAdapter still works for parent chrome', () => {
    const target = {}
    const adapter = createWindowAdapter(target)
    adapter.defineGlobal('x', 1)
    expect(target.x).toBe(1)
    adapter.teardown()
    expect(target.x).toBeUndefined()
  })
})
