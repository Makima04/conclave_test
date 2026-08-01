/**
 * Isolation layer public surface (PR-09).
 *
 * @module st-host/isolation
 */

export {
  createWindowAdapter,
  createIframeAdapter,
} from './GlobalAdapter.js';

export {
  BRIDGE_PROTOCOL_VERSION,
  TH_CALL_METHODS,
  MVU_CALL_METHODS,
  STORAGE_METHODS,
  MOUNT_METHODS,
  DIAG_METHODS,
  METHOD_ALLOWLIST,
  ALLOWED_TYPES,
  isMethodAllowed,
  isTypeAllowed,
  createRequest,
  createResponse,
  isBridgeEnvelope,
  isBridgeRequest,
  isBridgeResponse,
  validateRequest,
  respondTo,
} from './BridgeProtocol.js';

export { createBridgeHost } from './BridgeHost.js';
export { buildBridgeClientSource } from './bridgeClientSource.js';
export {
  createCardFrame,
  buildCardSrcdoc,
  resolveSandboxAttribute,
} from './CardFrame.js';
export {
  isCardIframeEnabled,
  isIframeSameOriginEnabled,
  CARD_IFRAME_KEY,
  IFRAME_SAME_ORIGIN_KEY,
} from './flags.js';
