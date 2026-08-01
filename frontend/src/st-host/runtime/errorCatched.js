/**
 * ST / JS-Slash-Runner `errorCatched` shim.
 *
 * Cards (e.g. 真实静浦 II) boot with `$(errorCatched(init))` — without this global,
 * jQuery ready never runs the real init and empty shells stay empty.
 *
 * Behavior: wrap a function so sync throws and Promise rejections are logged
 * (and toasted when `toastr` exists) instead of killing the boot chain silently.
 *
 * @module st-host/runtime/errorCatched
 */

/**
 * @param {(...args: unknown[]) => unknown} fn
 * @param {{
 *   label?: string,
 *   onError?: (err: unknown) => void,
 *   rethrow?: boolean,
 * }} [options]
 * @returns {(...args: unknown[]) => unknown}
 */
export function errorCatched(fn, options = {}) {
  const label = options.label || 'errorCatched'
  const rethrow = options.rethrow === true
  const onError =
    typeof options.onError === 'function'
      ? options.onError
      : defaultOnError

  if (typeof fn !== 'function') {
    console.warn(`[${label}] expected a function, got`, fn)
    return function errorCatchedInvalid() {
      return undefined
    }
  }

  return function errorCatchedWrapper(...args) {
    try {
      const result = fn.apply(this, args)
      if (result != null && typeof result.then === 'function') {
        return Promise.resolve(result).catch((err) => {
          onError(err, label)
          if (rethrow) return Promise.reject(err)
          return undefined
        })
      }
      return result
    } catch (err) {
      onError(err, label)
      if (rethrow) throw err
      return undefined
    }
  }
}

/**
 * @param {unknown} err
 * @param {string} label
 */
function defaultOnError(err, label) {
  const message =
    err instanceof Error
      ? err.message
      : err != null
        ? String(err)
        : 'Unknown error'
  console.error(`[${label}]`, err)
  try {
    const toast =
      typeof globalThis !== 'undefined' ? globalThis.toastr : undefined
    if (toast && typeof toast.error === 'function') {
      toast.error(message)
    }
  } catch {
    /* ignore toast failures */
  }
}

/**
 * Install on a global target (window) if missing or always overwrite when forced.
 *
 * @param {Record<string, unknown>} [target]
 * @param {{ force?: boolean }} [opts]
 * @returns {typeof errorCatched}
 */
export function installErrorCatched(target, opts = {}) {
  const t =
    target ||
    (typeof globalThis !== 'undefined' ? globalThis : /** @type {any} */ ({}))
  if (!opts.force && typeof t.errorCatched === 'function') {
    return t.errorCatched
  }
  t.errorCatched = errorCatched
  return errorCatched
}
