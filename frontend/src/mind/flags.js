/**
 * Mind feature flag (architecture §6.1 / KD6).
 * ON only when localStorage `conclave:feature:mind` === '1' OR `?mind=1`.
 * Default OFF.
 *
 * @module mind/flags
 */

export const MIND_FEATURE_KEY = 'conclave:feature:mind';

/**
 * @param {{ localStorage?: Storage | null, location?: { search?: string } | null }} [env]
 * @returns {boolean}
 */
export function isMindEnabled(env = {}) {
  try {
    const storage =
      env.localStorage !== undefined
        ? env.localStorage
        : typeof globalThis !== 'undefined'
          ? globalThis.localStorage
          : null;
    if (storage && typeof storage.getItem === 'function') {
      if (storage.getItem(MIND_FEATURE_KEY) === '1') return true;
    }
  } catch {
    /* ignore storage errors */
  }

  try {
    const loc =
      env.location !== undefined
        ? env.location
        : typeof globalThis !== 'undefined'
          ? globalThis.location
          : null;
    const search = loc && typeof loc.search === 'string' ? loc.search : '';
    if (search) {
      const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
      if (params.get('mind') === '1') return true;
    }
  } catch {
    /* ignore URL errors */
  }

  return false;
}
