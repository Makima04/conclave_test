import { describe, it, expect, vi, afterEach } from 'vitest'
import { errorCatched, installErrorCatched } from './errorCatched.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('errorCatched', () => {
  it('returns wrapped fn result on success', () => {
    const wrapped = errorCatched((a, b) => a + b)
    expect(wrapped(2, 3)).toBe(5)
  })

  it('swallows sync throw by default and logs', () => {
    const err = new Error('boom')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapped = errorCatched(() => {
      throw err
    })
    expect(wrapped()).toBeUndefined()
    expect(spy).toHaveBeenCalled()
  })

  it('catches async rejection', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapped = errorCatched(async () => {
      throw new Error('async-fail')
    })
    await expect(wrapped()).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalled()
  })

  it('rethrow option propagates', () => {
    const wrapped = errorCatched(
      () => {
        throw new Error('x')
      },
      { rethrow: true },
    )
    expect(() => wrapped()).toThrow('x')
  })

  it('installErrorCatched sets global', () => {
    const target = {}
    installErrorCatched(target)
    expect(typeof target.errorCatched).toBe('function')
    const w = target.errorCatched(() => 42)
    expect(w()).toBe(42)
  })
})
