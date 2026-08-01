import { describe, it, expect, vi } from 'vitest'
import { createSessionKernel } from './SessionKernel.js'

/**
 * Minimal store for dispose-order tests.
 * @param {object} [initial]
 */
function createMockStore(initial = {}) {
  let phase = initial.phase || 'running'
  let runtime = initial.runtime ?? null
  let lastError = null
  let capabilities = null
  let cardName = initial.cardName || 'TestCard'

  return {
    getPhase: () => phase,
    setPhase: (p) => {
      phase = p
    },
    getRuntime: () => runtime,
    setRuntime: (r) => {
      runtime = r
    },
    clearRuntime: () => {
      runtime = null
    },
    getLastError: () => lastError,
    setLastError: (e) => {
      lastError = e
    },
    getCardName: () => cardName,
    getCapabilities: () => capabilities,
    setCapabilities: (c) => {
      capabilities = c
    },
    getSnapshot: () => ({ phase, capabilities, cardName, lastError }),
    getRequirements: () => null,
    applyInitPayload: vi.fn(),
  }
}

function createOrderedHooks() {
  const order = []
  const push = (name) => () => {
    order.push(name)
  }
  return {
    order,
    hooks: {
      abortScripts: push('abortScripts'),
      clearPendingRefreshTimers: push('clearPendingRefreshTimers'),
      cleanupCardArtifacts: push('cleanupCardArtifacts'),
      onTeardown: push('onTeardown'),
      renderShell: vi.fn(),
      beginCardArtifactTracking: vi.fn(),
      showOpeningView: vi.fn(),
      executeTavernHelperScripts: vi.fn(),
      showError: vi.fn(),
    },
  }
}

describe('SessionKernel dispose order (PR-08)', () => {
  it('teardown calls abort → timers → artifacts → registry → onTeardown', () => {
    const registryTeardown = vi.fn()
    const eventClear = vi.fn()
    const store = createMockStore({
      phase: 'running',
      runtime: {
        capabilityRegistry: { teardown: registryTeardown },
        eventBus: { clear: eventClear },
      },
    })
    const { order, hooks } = createOrderedHooks()
    const kernel = createSessionKernel({
      store,
      shell: { setDiagnostics: vi.fn() },
      createRuntime: () => ({}),
      hooks,
    })

    kernel.teardown({ toIdle: true })

    expect(order).toEqual([
      'abortScripts',
      'clearPendingRefreshTimers',
      'cleanupCardArtifacts',
      'onTeardown',
    ])
    expect(registryTeardown).toHaveBeenCalled()
    expect(eventClear).toHaveBeenCalled()
    expect(store.getRuntime()).toBeNull()
    expect(store.getPhase()).toBe('idle')
  })

  it('fail matches teardown dispose order including clearPendingRefreshTimers', () => {
    const adapterTeardown = vi.fn()
    const eventClear = vi.fn()
    const store = createMockStore({
      phase: 'running',
      runtime: {
        adapter: { teardown: adapterTeardown },
        eventBus: { clear: eventClear },
      },
    })
    const { order, hooks } = createOrderedHooks()
    const kernel = createSessionKernel({
      store,
      shell: { setDiagnostics: vi.fn() },
      createRuntime: () => ({}),
      hooks,
    })

    kernel.fail(new Error('boom'), { showUi: true })

    expect(order).toEqual([
      'abortScripts',
      'clearPendingRefreshTimers',
      'cleanupCardArtifacts',
      'onTeardown',
    ])
    expect(adapterTeardown).toHaveBeenCalled()
    expect(eventClear).toHaveBeenCalled()
    expect(store.getRuntime()).toBeNull()
    expect(store.getPhase()).toBe('error')
    expect(store.getLastError()).toBe('boom')
    expect(hooks.showError).toHaveBeenCalledWith('boom')
  })

  it('teardown is safe when hooks are missing', () => {
    const store = createMockStore({ phase: 'running', runtime: { adapter: { teardown: vi.fn() } } })
    const kernel = createSessionKernel({
      store,
      shell: { setDiagnostics: vi.fn() },
      createRuntime: () => ({}),
      hooks: {},
    })
    expect(() => kernel.teardown({ toIdle: true })).not.toThrow()
    expect(store.getPhase()).toBe('idle')
  })
})
