/**
 * P0 Capability Catalog seed table (architecture-host-mind.md §4.2).
 *
 * Surfaces may be provided after createRuntime builds TH/Mvu, or install can
 * run libs/stubs first and re-bind surfaces later.
 *
 * @module st-host/capabilities/CapabilityCatalog
 */

/** Kernel base set always planned for install (requiredByDefault: true). */
export const ALWAYS_INSTALL_IDS = [
  'lib.jquery',
  'lib.lodash',
  'th.surface',
  'event.bus',
  'st.context',
  'storage.scoped',
];

/**
 * @typedef {'ready'|'stub'|'missing'|'disabled'} CapabilityStatus
 * @typedef {'kernel'|'tavern_helper'|'mvu'|'slash'|'regex'|'extension'|'library'} CapabilityKind
 *
 * @typedef {Object} CapabilityInstallResult
 * @property {CapabilityStatus} status
 * @property {string} [detail]
 * @property {string[]} [providedGlobals]
 *
 * @typedef {Object} CapabilityDescriptor
 * @property {string} id
 * @property {CapabilityKind} kind
 * @property {string} [globalName]
 * @property {boolean} requiredByDefault
 * @property {() => CapabilityInstallResult | Promise<CapabilityInstallResult>} install
 * @property {() => void | Promise<void>} [teardown]
 */

/**
 * @typedef {Object} CapabilitySurfaces
 * @property {unknown} [jquery]
 * @property {unknown} [lodash]
 * @property {object} [tavernHelper]
 * @property {object} [mvu]
 * @property {object} [eventApi]  // { eventOn, eventOnce, eventEmit, eventRemoveListener }
 * @property {{ getContext: () => object }} [contextFactory]
 * @property {Function} [triggerSlash]
 * @property {Function} [formatAsTavernRegexedString]
 * @property {boolean|object|Function} [regexPipeline]  // true, processDisplay fn, or { processDisplay }
 * @property {boolean} [regexDisplayReady]
 * @property {boolean} [storageReady]
 * @property {import('../isolation/GlobalAdapter.js').GlobalAdapter} [adapter]
 */

/**
 * @param {{ adapter?: import('../isolation/GlobalAdapter.js').GlobalAdapter, surfaces?: CapabilitySurfaces }} [options]
 */
export function createCapabilityCatalog({ adapter, surfaces = {} } = {}) {
  /**
   * @param {string} path
   * @param {unknown} value
   */
  function define(path, value) {
    if (adapter && typeof adapter.defineGlobal === 'function') {
      adapter.defineGlobal(path, value);
      return;
    }
    if (typeof window !== 'undefined') {
      window[path] = value;
    }
  }

  function hasWindowProp(name) {
    return typeof window !== 'undefined' && window[name] != null;
  }

  /** @type {CapabilityDescriptor[]} */
  const descriptors = [
    {
      id: 'lib.jquery',
      kind: 'library',
      globalName: '$',
      requiredByDefault: true,
      install() {
        const $ =
          surfaces.jquery ??
          (typeof window !== 'undefined' ? window.$ ?? window.jQuery : null);
        if (!$) {
          return { status: 'missing', detail: 'jQuery ($) not available' };
        }
        define('$', $);
        define('jQuery', $);
        return { status: 'ready', providedGlobals: ['$', 'jQuery'] };
      },
    },
    {
      id: 'lib.lodash',
      kind: 'library',
      globalName: '_',
      requiredByDefault: true,
      install() {
        const _ =
          surfaces.lodash ??
          (typeof window !== 'undefined' ? window._ ?? window.lodash : null);
        if (!_) {
          return { status: 'missing', detail: 'lodash (_) not available' };
        }
        define('_', _);
        define('lodash', _);
        return { status: 'ready', providedGlobals: ['_', 'lodash'] };
      },
    },
    {
      id: 'lib.fontawesome',
      kind: 'library',
      requiredByDefault: false,
      install() {
        // CSS is imported in main.js; treat as ready when catalog is asked.
        return {
          status: 'ready',
          detail: 'Font Awesome CSS imported by host bootstrap',
        };
      },
    },
    {
      id: 'th.surface',
      kind: 'tavern_helper',
      globalName: 'TavernHelper',
      requiredByDefault: true,
      install() {
        const th = surfaces.tavernHelper;
        if (!th || typeof th !== 'object') {
          if (hasWindowProp('TavernHelper') && hasWindowProp('getChatMessages')) {
            return {
              status: 'ready',
              detail: 'TavernHelper already on window',
              providedGlobals: ['TavernHelper', 'getChatMessages'],
            };
          }
          return {
            status: 'missing',
            detail: 'TavernHelper surface not provided (createRuntime first)',
          };
        }
        define('TavernHelper', th);
        const methodGlobals = [
          'triggerSlash',
          'getCurrentMessageId',
          'getChatMessages',
          'setChatMessages',
          'setChatMessage',
          'getLorebookEntries',
          'setLorebookEntries',
          'getVariables',
          'replaceVariables',
          'updateVariablesWith',
          'insertOrAssignVariables',
          'insertVariables',
          'deleteVariable',
          'initializeGlobal',
          'waitGlobalInitialized',
          'formatAsTavernRegexedString',
          'eventOn',
          'eventOnce',
          'eventEmit',
          'eventRemoveListener',
        ];
        const provided = ['TavernHelper'];
        for (const name of methodGlobals) {
          if (typeof th[name] === 'function') {
            define(name, th[name]);
            provided.push(name);
          }
        }
        return { status: 'ready', providedGlobals: provided };
      },
    },
    {
      id: 'mvu',
      kind: 'mvu',
      globalName: 'Mvu',
      // required only when shim `mvu` present — not requiredByDefault
      requiredByDefault: false,
      install() {
        const mvu = surfaces.mvu;
        if (!mvu || typeof mvu !== 'object') {
          if (hasWindowProp('Mvu')) {
            return {
              status: 'ready',
              detail: 'Mvu already on window; parseMessage may be stub',
              providedGlobals: ['Mvu'],
            };
          }
          return {
            status: 'missing',
            detail: 'Mvu surface not provided (createRuntime first)',
          };
        }
        define('Mvu', mvu);
        return {
          status: 'ready',
          detail: 'Mvu ready subset; parseMessage is a no-op stub (returns oldData)',
          providedGlobals: ['Mvu'],
        };
      },
    },
    {
      id: 'slash.runtime',
      kind: 'slash',
      globalName: 'triggerSlash',
      requiredByDefault: false,
      install() {
        const fn =
          surfaces.triggerSlash ||
          surfaces.tavernHelper?.triggerSlash ||
          (typeof window !== 'undefined' ? window.triggerSlash : null);

        if (typeof fn === 'function') {
          define('triggerSlash', fn);
          return {
            status: 'stub',
            detail: 'slash.runtime: triggerSlash logs + returns empty string (P0)',
            providedGlobals: ['triggerSlash'],
          };
        }

        const stub = async (command) => {
          console.warn('[ConclaveSTHost] slash.runtime stub triggerSlash:', command);
          return '';
        };
        define('triggerSlash', stub);
        return {
          status: 'stub',
          detail: 'slash.runtime installed as warn+empty stub',
          providedGlobals: ['triggerSlash'],
        };
      },
    },
    {
      id: 'event.bus',
      kind: 'kernel',
      globalName: 'eventSource',
      requiredByDefault: true,
      install() {
        const api = surfaces.eventApi;
        if (!api || typeof api.eventOn !== 'function') {
          if (
            hasWindowProp('eventOn') &&
            hasWindowProp('eventEmit') &&
            hasWindowProp('eventSource')
          ) {
            return {
              status: 'ready',
              detail: 'event bus already on window',
              providedGlobals: ['eventOn', 'eventOnce', 'eventEmit', 'eventRemoveListener', 'eventSource'],
            };
          }
          return {
            status: 'missing',
            detail: 'eventApi surface not provided (createRuntime first)',
          };
        }
        define('eventOn', api.eventOn);
        define('eventOnce', api.eventOnce);
        define('eventEmit', api.eventEmit);
        define('eventRemoveListener', api.eventRemoveListener);
        define('eventSource', {
          on: api.eventOn,
          once: api.eventOnce,
          emit: api.eventEmit,
          removeListener: api.eventRemoveListener,
        });
        return {
          status: 'ready',
          providedGlobals: [
            'eventOn',
            'eventOnce',
            'eventEmit',
            'eventRemoveListener',
            'eventSource',
          ],
        };
      },
    },
    {
      id: 'regex.display',
      kind: 'regex',
      globalName: 'formatAsTavernRegexedString',
      requiredByDefault: false,
      install() {
        const existing =
          surfaces.formatAsTavernRegexedString ||
          surfaces.tavernHelper?.formatAsTavernRegexedString;
        const pipeline = surfaces.regexPipeline;
        const pipelineFn =
          typeof pipeline === 'function'
            ? pipeline
            : pipeline && typeof pipeline === 'object' && typeof pipeline.processDisplay === 'function'
              ? (text, ...rest) => pipeline.processDisplay(text, ...rest)
              : null;
        const pipelineReady =
          surfaces.regexDisplayReady === true ||
          pipeline === true ||
          typeof pipelineFn === 'function';

        // Prefer: regexPipeline or formatAsTavernRegexedString → ready (RenderPipeline).
        if (typeof existing === 'function' || pipelineReady) {
          const fn =
            typeof existing === 'function'
              ? existing
              : typeof pipelineFn === 'function'
                ? pipelineFn
                : (text) => String(text ?? '');
          define('formatAsTavernRegexedString', fn);
          return {
            status: 'ready',
            detail: 'RenderPipeline processDisplay',
            providedGlobals: ['formatAsTavernRegexedString'],
          };
        }

        let warned = false;
        const identity = (text) => {
          if (!warned) {
            warned = true;
            console.warn(
              '[ConclaveSTHost] regex.display is identity stub until P1 RenderPipeline'
            );
          }
          return String(text ?? '');
        };

        define('formatAsTavernRegexedString', identity);
        return {
          status: 'stub',
          detail:
            'regex.display identity until surfaces.regexPipeline / formatAsTavernRegexedString',
          providedGlobals: ['formatAsTavernRegexedString'],
        };
      },
    },
    {
      id: 'st.context',
      kind: 'kernel',
      globalName: 'SillyTavern',
      requiredByDefault: true,
      install() {
        const factory = surfaces.contextFactory;
        if (!factory || typeof factory.getContext !== 'function') {
          if (
            typeof window !== 'undefined' &&
            window.SillyTavern &&
            typeof window.SillyTavern.getContext === 'function'
          ) {
            // Guard: must not be TavernHelper
            try {
              const ctx = window.SillyTavern.getContext();
              if (ctx && ctx === window.TavernHelper) {
                return {
                  status: 'missing',
                  detail: 'SillyTavern.getContext returns TavernHelper (forbidden)',
                };
              }
            } catch {
              /* ignore probe errors */
            }
            return {
              status: 'ready',
              detail: 'SillyTavern already on window',
              providedGlobals: ['SillyTavern'],
            };
          }
          return {
            status: 'missing',
            detail: 'ContextFactory not provided (createRuntime first)',
          };
        }
        define('SillyTavern', {
          getContext: () => factory.getContext(),
        });
        return {
          status: 'ready',
          detail: 'SillyTavern.getContext via ContextFactory (≠ TavernHelper)',
          providedGlobals: ['SillyTavern'],
        };
      },
    },
    {
      id: 'storage.scoped',
      kind: 'kernel',
      requiredByDefault: true,
      install() {
        const ready =
          surfaces.storageReady === true ||
          (typeof window !== 'undefined' &&
            typeof window.__conclaveCreateScopedLocalStorage === 'function' &&
            typeof window.__conclaveCreateScopedIndexedDB === 'function');
        if (!ready) {
          return {
            status: 'missing',
            detail: 'scoped storage helpers not installed on window',
          };
        }
        return {
          status: 'ready',
          detail: 'scoped localStorage/indexedDB helpers present',
          providedGlobals: [
            '__conclaveCreateScopedLocalStorage',
            '__conclaveCreateScopedIndexedDB',
          ],
        };
      },
    },
  ];

  /** @type {Map<string, CapabilityDescriptor>} */
  const byId = new Map(descriptors.map((d) => [d.id, d]));

  return {
    alwaysInstallIds() {
      return [...ALWAYS_INSTALL_IDS];
    },
    /**
     * @param {string} id
     * @returns {CapabilityDescriptor|undefined}
     */
    get(id) {
      return byId.get(id);
    },
    /**
     * @returns {CapabilityDescriptor[]}
     */
    list() {
      return [...descriptors];
    },
  };
}
