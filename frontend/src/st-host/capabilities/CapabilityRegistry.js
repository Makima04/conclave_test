/**
 * CapabilityRegistry — plan + install capabilities from card requirements.
 *
 * @module st-host/capabilities/CapabilityRegistry
 */

import {
  mapGlobalToCapabilityId,
  mapShimToCapabilityId,
  planInstall,
} from './installFromRequirements.js';
import { ALWAYS_INSTALL_IDS } from './CapabilityCatalog.js';

/**
 * Feature flag: strict_capabilities default ON.
 * Set localStorage `conclave:feature:strict_capabilities` to `'0'` to disable.
 * @returns {boolean}
 */
export function isStrictCapabilities() {
  try {
    return localStorage.getItem('conclave:feature:strict_capabilities') !== '0';
  } catch {
    return true;
  }
}

/**
 * @typedef {Object} CapabilityInstallReport
 * @property {Record<string, { status: string, detail?: string, providedGlobals?: string[] }>} byId
 * @property {string[]} installed
 * @property {string[]} stubs
 * @property {string[]} missing
 * @property {string[]} warnings
 * @property {string[]} blocking
 * @property {boolean} ok
 */

/**
 * @returns {CapabilityInstallReport}
 */
function emptyReport() {
  return {
    byId: {},
    installed: [],
    stubs: [],
    missing: [],
    warnings: [],
    blocking: [],
    ok: true,
  };
}

/**
 * @param {{ catalog: object, adapter?: object, strict?: boolean }} options
 */
export function createCapabilityRegistry({ catalog, adapter, strict = true } = {}) {
  if (!catalog || typeof catalog.get !== 'function') {
    throw new Error('createCapabilityRegistry: catalog with get() is required');
  }

  /** @type {CapabilityInstallReport} */
  let lastReport = emptyReport();
  /** @type {Array<() => void | Promise<void>>} */
  const teardowns = [];

  /**
   * P2: soft-note capability ids provided by ExtensionManager without a full reinstall.
   * Updates lastReport.byId / installed so diagnostics can surface extension caps.
   *
   * @param {string} extensionName
   * @param {string} capabilityId
   * @param {string} [status='ready']
   */
  function noteExtensionCaps(extensionName, capabilityId, status = 'ready') {
    const id = String(capabilityId || '');
    if (!id) return;
    const detail = `extension:${extensionName || 'unknown'}`;
    lastReport = {
      ...lastReport,
      byId: {
        ...lastReport.byId,
        [id]: { status, detail },
      },
      installed: lastReport.installed.includes(id)
        ? lastReport.installed
        : [...lastReport.installed, id],
    };
  }

  /**
   * @param {object|null|undefined} requirements
   * @returns {Promise<CapabilityInstallReport>}
   */
  async function install(requirements) {
    const alwaysIds =
      typeof catalog.alwaysInstallIds === 'function'
        ? catalog.alwaysInstallIds()
        : [...ALWAYS_INSTALL_IDS];

    const req = requirements && typeof requirements === 'object' ? requirements : {};
    const ids = planInstall(req, { alwaysInstallIds: alwaysIds });

    /** @type {Record<string, { status: string, detail?: string, providedGlobals?: string[] }>} */
    const byId = {};
    /** @type {string[]} */
    const installed = [];
    /** @type {string[]} */
    const stubs = [];
    /** @type {string[]} */
    const missing = [];
    /** @type {string[]} */
    const warnings = Array.isArray(req.warnings) ? [...req.warnings] : [];
    /** @type {string[]} */
    const blocking = [];

    // Free-scanned globals that we cannot map → non-blocking warnings
    const scannedGlobals = [
      ...(req.globals || []),
      ...(req.window_globals || []),
      ...(req.parent_globals || []),
    ];
    for (const g of scannedGlobals) {
      if (!mapGlobalToCapabilityId(g)) {
        warnings.push(`Unknown global requirement (not installed): ${g}`);
      }
    }

    for (const id of ids) {
      const desc = catalog.get(id);
      if (!desc) {
        byId[id] = { status: 'missing', detail: `No catalog entry for ${id}` };
        missing.push(id);
        continue;
      }

      try {
        const result = await Promise.resolve(desc.install());
        const status = result?.status || 'missing';
        byId[id] = {
          status,
          detail: result?.detail,
          providedGlobals: result?.providedGlobals,
        };

        if (status === 'ready') {
          installed.push(id);
        } else if (status === 'stub') {
          stubs.push(id);
          installed.push(id);
        } else if (status === 'missing') {
          missing.push(id);
        } else if (status === 'disabled') {
          // not installed
        } else {
          missing.push(id);
        }

        if (typeof desc.teardown === 'function') {
          teardowns.push(desc.teardown);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        byId[id] = { status: 'missing', detail: message };
        missing.push(id);
      }
    }

    if (strict) {
      // required_shims → blocking if mapped cap is missing (stub does NOT block)
      for (const shim of req.required_shims || []) {
        const capId = mapShimToCapabilityId(shim);
        if (!capId) {
          warnings.push(`Unmapped required_shim: ${shim}`);
          continue;
        }
        const result = byId[capId];
        if (!result || result.status === 'missing') {
          if (!blocking.includes(capId)) blocking.push(capId);
        }
      }

      // requiredByDefault catalog entries that are missing
      for (const id of ids) {
        const desc = catalog.get(id);
        if (!desc?.requiredByDefault) continue;
        const result = byId[id];
        if (!result || result.status === 'missing') {
          if (!blocking.includes(id)) blocking.push(id);
        }
      }

      // Always-install requiredByDefault not even planned somehow
      for (const id of alwaysIds) {
        const desc = catalog.get(id);
        if (!desc?.requiredByDefault) continue;
        const result = byId[id];
        if (!result || result.status === 'missing') {
          if (!blocking.includes(id)) blocking.push(id);
        }
      }
    }

    const ok = !strict || blocking.length === 0;
    lastReport = {
      byId,
      installed,
      stubs,
      missing,
      warnings,
      blocking,
      ok,
    };
    return lastReport;
  }

  function getReport() {
    return lastReport;
  }

  async function teardown() {
    for (let i = teardowns.length - 1; i >= 0; i -= 1) {
      try {
        await Promise.resolve(teardowns[i]());
      } catch (error) {
        console.warn('[CapabilityRegistry] teardown error:', error);
      }
    }
    teardowns.length = 0;
    if (adapter && typeof adapter.teardown === 'function') {
      try {
        adapter.teardown();
      } catch (error) {
        console.warn('[CapabilityRegistry] adapter.teardown error:', error);
      }
    }
    lastReport = emptyReport();
  }

  return {
    install,
    getReport,
    teardown,
    noteExtensionCaps,
  };
}
