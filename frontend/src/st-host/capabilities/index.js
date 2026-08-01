/**
 * st-host capabilities public surface.
 * @module st-host/capabilities
 */

export {
  ALWAYS_INSTALL_IDS,
  createCapabilityCatalog,
} from './CapabilityCatalog.js';

export {
  createCapabilityRegistry,
  isStrictCapabilities,
} from './CapabilityRegistry.js';

export {
  mapShimToCapabilityId,
  mapGlobalToCapabilityId,
  mapLib,
  planInstall,
} from './installFromRequirements.js';
