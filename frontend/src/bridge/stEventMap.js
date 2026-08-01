/**
 * ST / MVU event name map — single place for host-internal aliases.
 * Mind must not hardcode `mag_variable_update_ended`; use ports or these constants.
 *
 * @module bridge/stEventMap
 */

/** MVU / MagVarUpdate event strings (match Mvu.events on the host surface). */
export const MVU_EVENTS = Object.freeze({
  VARIABLE_INITIALIZED: 'mag_variable_initiailized', // intentional ST typo preserved
  VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
  COMMAND_PARSED: 'mag_command_parsed',
  VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
  BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
});

/**
 * Lifecycle events emitted by SessionKernel / host generate path.
 * @type {Readonly<Record<string, import('./ports.js').LifecycleEvent>>}
 */
export const LIFECYCLE_EVENTS = Object.freeze({
  SESSION_LOADING: 'sessionLoading',
  SESSION_READY: 'sessionReady',
  BEFORE_GENERATE: 'beforeGenerate',
  AFTER_GENERATE: 'afterGenerate',
  SESSION_TEARDOWN: 'sessionTeardown',
  CAPABILITY_INSTALLED: 'capabilityInstalled',
});

/**
 * Map a known ST/MVU or lifecycle alias to a canonical key.
 * Unknown names return null (caller may pass through raw).
 *
 * @param {string} name
 * @returns {{ kind: 'mvu'|'lifecycle', key: string, value: string } | null}
 */
export function resolveStEvent(name) {
  const raw = String(name || '');
  if (!raw) return null;

  for (const [key, value] of Object.entries(MVU_EVENTS)) {
    if (raw === value || raw === key) {
      return { kind: 'mvu', key, value };
    }
  }

  for (const [key, value] of Object.entries(LIFECYCLE_EVENTS)) {
    if (raw === value || raw === key) {
      return { kind: 'lifecycle', key, value };
    }
  }

  return null;
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isKnownMvuEvent(name) {
  const resolved = resolveStEvent(name);
  return !!(resolved && resolved.kind === 'mvu');
}
