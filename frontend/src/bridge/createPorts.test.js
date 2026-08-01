import { describe, it, expect, vi } from 'vitest'
import { createPorts, createLifecycle, createDiagnostics } from './createPorts.js'
import { LIFECYCLE_EVENTS, MVU_EVENTS, resolveStEvent, isKnownMvuEvent } from './stEventMap.js'

describe('stEventMap', () => {
  it('resolves MVU and lifecycle names', () => {
    expect(resolveStEvent(MVU_EVENTS.VARIABLE_UPDATE_ENDED)).toMatchObject({
      kind: 'mvu',
      key: 'VARIABLE_UPDATE_ENDED',
    })
    expect(resolveStEvent(LIFECYCLE_EVENTS.SESSION_READY)).toMatchObject({
      kind: 'lifecycle',
      value: 'sessionReady',
    })
    expect(isKnownMvuEvent('mag_variable_update_ended')).toBe(true)
    expect(isKnownMvuEvent('sessionReady')).toBe(false)
    expect(resolveStEvent('totally-unknown')).toBeNull()
  })
})

describe('Lifecycle', () => {
  it('on/emit and unsubscribe', async () => {
    const life = createLifecycle()
    const fn = vi.fn()
    const off = life.on('sessionReady', fn)
    await life.emit('sessionReady', { cardName: 'Demo' })
    expect(fn).toHaveBeenCalledWith({ cardName: 'Demo' })
    off()
    await life.emit('sessionReady', { cardName: 'X' })
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('createPorts', () => {
  it('transcript + promptInjection + lifecycle + diagnostics', async () => {
    const messages = []
    const runtimeState = { messages, mvuData: { stat_data: {} } }
    const ports = createPorts({
      getRuntime: () => ({ runtimeState }),
    })

    const ready = vi.fn()
    ports.lifecycle.on('sessionReady', ready)
    await ports.lifecycle.emit('sessionReady', { ok: true })
    expect(ready).toHaveBeenCalledWith({ ok: true })

    const appended = ports.transcript.append({ role: 'user', message: 'hi' })
    expect(appended.message_id).toBe(0)
    expect(ports.transcript.getMessages()).toHaveLength(1)
    expect(ports.transcript.getMvu()).toEqual({ stat_data: {} })

    ports.transcript.replaceMvu({ stat_data: { hp: 1 } }, 'test')
    expect(ports.transcript.getMvu()).toEqual({ stat_data: { hp: 1 } })
    expect(() => ports.transcript.replaceMvu({}, '')).toThrow(/reason/)

    ports.promptInjection.set('mind.primary', {
      content: 'memory block',
      position: 'after_scenario',
      source: 'mind',
    })
    expect(ports.promptInjection.list()).toHaveLength(1)
    ports.promptInjection.clear('mind.primary')
    expect(ports.promptInjection.list()).toHaveLength(0)

    ports.diagnostics.log('info', 'boot', { n: 1 })
    ports.diagnostics.gauge('mind.active_memories', 3)
    const tail = ports.diagnostics.tail()
    expect(tail.some((e) => e.code === 'boot')).toBe(true)
    expect(tail.some((e) => e.name === 'mind.active_memories' && e.value === 3)).toBe(true)
  })

  it('createDiagnostics caps ring buffer', () => {
    const diag = createDiagnostics({ maxEntries: 3 })
    diag.log('info', 'a')
    diag.log('info', 'b')
    diag.log('info', 'c')
    diag.log('info', 'd')
    expect(diag.tail()).toHaveLength(3)
    expect(diag.tail().map((e) => e.code)).toEqual(['b', 'c', 'd'])
  })
})
