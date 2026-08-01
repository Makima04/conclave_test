import { describe, it, expect, vi } from 'vitest'
import { createEventBus } from './EventBus.js'

describe('EventBus', () => {
  it('on + emit delivers args and stop unsubscribes', async () => {
    const bus = createEventBus()
    const fn = vi.fn()
    const sub = bus.on('ping', fn)

    await bus.emit('ping', 1, 'a')
    expect(fn).toHaveBeenCalledWith(1, 'a')

    sub.stop()
    await bus.emit('ping', 2)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('once only fires once', async () => {
    const bus = createEventBus()
    const fn = vi.fn()
    bus.once('once-evt', fn)

    await bus.emit('once-evt', 'x')
    await bus.emit('once-evt', 'y')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('x')
  })

  it('eventOn / eventEmit aliases match TH surface', async () => {
    const bus = createEventBus()
    const fn = vi.fn()
    bus.eventOn('mag_variable_update_ended', fn)
    await bus.eventEmit('mag_variable_update_ended', { a: 1 }, { a: 0 })
    expect(fn).toHaveBeenCalledWith({ a: 1 }, { a: 0 })
  })

  it('asEventSource exposes ST-shaped API', async () => {
    const bus = createEventBus()
    const src = bus.asEventSource()
    const fn = vi.fn()
    src.on('e', fn)
    await src.emit('e', 9)
    expect(fn).toHaveBeenCalledWith(9)
    src.removeListener('e', fn)
    await src.emit('e', 10)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('clear removes all listeners', async () => {
    const bus = createEventBus()
    const fn = vi.fn()
    bus.on('a', fn)
    bus.clear()
    await bus.emit('a')
    expect(fn).not.toHaveBeenCalled()
  })
})
