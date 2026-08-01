/**
 * Isolation feature flags (PR-09).
 *
 * @module st-host/isolation/flags
 */

const CARD_IFRAME_KEY = 'conclave:feature:card_iframe';
const IFRAME_SAME_ORIGIN_KEY = 'conclave:feature:iframe_same_origin';

/**
 * Card UI iframe isolation. Default **off** — same-window path remains default.
 * Enable via localStorage `conclave:feature:card_iframe` === '1' or `?card_iframe=1`.
 *
 * @param {{ storage?: Storage|null, search?: string }} [opts]
 * @returns {boolean}
 */
export function isCardIframeEnabled(opts = {}) {
  try {
    const storage =
      opts.storage !== undefined
        ? opts.storage
        : typeof globalThis !== 'undefined'
          ? globalThis.localStorage
          : null;
    if (storage?.getItem?.(CARD_IFRAME_KEY) === '1') return true;

    const search =
      opts.search !== undefined
        ? opts.search
        : typeof globalThis !== 'undefined' && globalThis.location
          ? globalThis.location.search
          : '';
    if (search) {
      const params = new URLSearchParams(
        search.startsWith('?') ? search.slice(1) : search,
      );
      if (params.get('card_iframe') === '1') return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Residual-risk sandbox: include `allow-same-origin` with `allow-scripts`.
 * Enable via localStorage `conclave:feature:iframe_same_origin` === '1'.
 *
 * @param {{ storage?: Storage|null }} [opts]
 * @returns {boolean}
 */
export function isIframeSameOriginEnabled(opts = {}) {
  try {
    const storage =
      opts.storage !== undefined
        ? opts.storage
        : typeof globalThis !== 'undefined'
          ? globalThis.localStorage
          : null;
    return storage?.getItem?.(IFRAME_SAME_ORIGIN_KEY) === '1';
  } catch {
    return false;
  }
}

export { CARD_IFRAME_KEY, IFRAME_SAME_ORIGIN_KEY };
