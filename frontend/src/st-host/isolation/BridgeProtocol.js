/**
 * BridgeProtocol v1 — postMessage schema + frozen method allowlist (PR-09).
 *
 * Envelope:
 *   request  { v:1, id, sessionId, type, method?, args? }
 *   response { v:1, id, ok, result?, error? }
 *
 * @module st-host/isolation/BridgeProtocol
 */

/** Protocol version. */
export const BRIDGE_PROTOCOL_VERSION = 1;

/** @type {readonly string[]} */
export const TH_CALL_METHODS = Object.freeze([
  'getChatMessages',
  'setChatMessages',
  'setChatMessage',
  'getCurrentMessageId',
  'getVariables',
  'replaceVariables',
  'updateVariablesWith',
  'insertOrAssignVariables',
  'insertVariables',
  'deleteVariable',
  'getLorebookEntries',
  'setLorebookEntries',
  'triggerSlash',
  'formatAsTavernRegexedString',
]);

/** @type {readonly string[]} */
export const MVU_CALL_METHODS = Object.freeze([
  'getMvuData',
  'replaceMvuData',
  'parseMessage',
  'isDuringExtraAnalysis',
  // read-only events bag is exposed as method "events" (returns frozen map)
  'events',
]);

/** @type {readonly string[]} */
export const STORAGE_METHODS = Object.freeze([
  'getItem',
  'setItem',
  'removeItem',
  'clear',
]);

/** @type {readonly string[]} */
export const MOUNT_METHODS = Object.freeze(['setHtml', 'setHeadNodes']);

/** @type {readonly string[]} */
export const DIAG_METHODS = Object.freeze(['log']);

/**
 * type → allowed methods (null = type itself is the verb, no method field required).
 * event.on / event.off / event.once / event.emit / event.cb use type as the verb.
 *
 * @type {Readonly<Record<string, readonly string[]|null>>}
 */
export const METHOD_ALLOWLIST = Object.freeze({
  'th.call': TH_CALL_METHODS,
  'mvu.call': MVU_CALL_METHODS,
  'event.on': null,
  'event.off': null,
  'event.once': null,
  'event.emit': null,
  'event.cb': null,
  storage: STORAGE_METHODS,
  mount: MOUNT_METHODS,
  diag: DIAG_METHODS,
});

/** @type {ReadonlySet<string>} */
export const ALLOWED_TYPES = Object.freeze(
  new Set(Object.keys(METHOD_ALLOWLIST)),
);

/**
 * @param {string} type
 * @param {string} [method]
 * @returns {boolean}
 */
export function isMethodAllowed(type, method) {
  const key = String(type || '');
  if (!ALLOWED_TYPES.has(key)) return false;
  const methods = METHOD_ALLOWLIST[key];
  if (methods === null) return true;
  return methods.includes(String(method || ''));
}

/**
 * @param {string} type
 * @returns {boolean}
 */
export function isTypeAllowed(type) {
  return ALLOWED_TYPES.has(String(type || ''));
}

/**
 * Build a v1 request envelope.
 *
 * @param {{
 *   id: string,
 *   sessionId: string,
 *   type: string,
 *   method?: string,
 *   args?: unknown[],
 * }} fields
 * @returns {{ v:1, id:string, sessionId:string, type:string, method?:string, args?:unknown[] }}
 */
export function createRequest(fields) {
  const envelope = {
    v: BRIDGE_PROTOCOL_VERSION,
    id: String(fields.id ?? ''),
    sessionId: String(fields.sessionId ?? ''),
    type: String(fields.type ?? ''),
  };
  if (fields.method !== undefined && fields.method !== null) {
    envelope.method = String(fields.method);
  }
  if (fields.args !== undefined) {
    envelope.args = Array.isArray(fields.args) ? fields.args : [];
  }
  return envelope;
}

/**
 * Build a v1 response envelope.
 *
 * @param {{
 *   id: string,
 *   ok: boolean,
 *   result?: unknown,
 *   error?: { message?: string, code?: string }|null,
 * }} fields
 * @returns {{ v:1, id:string, ok:boolean, result?:unknown, error?:{ message:string, code:string } }}
 */
export function createResponse(fields) {
  const envelope = {
    v: BRIDGE_PROTOCOL_VERSION,
    id: String(fields.id ?? ''),
    ok: !!fields.ok,
  };
  if (fields.ok) {
    envelope.result = fields.result;
  } else {
    const err = fields.error || {};
    envelope.error = {
      message: String(err.message || 'bridge error'),
      code: String(err.code || 'bridge_error'),
    };
  }
  return envelope;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBridgeEnvelope(value) {
  if (!value || typeof value !== 'object') return false;
  const v = /** @type {Record<string, unknown>} */ (value);
  return v.v === BRIDGE_PROTOCOL_VERSION && typeof v.id === 'string';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBridgeRequest(value) {
  if (!isBridgeEnvelope(value)) return false;
  const v = /** @type {Record<string, unknown>} */ (value);
  return typeof v.sessionId === 'string' && typeof v.type === 'string';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBridgeResponse(value) {
  if (!isBridgeEnvelope(value)) return false;
  const v = /** @type {Record<string, unknown>} */ (value);
  return typeof v.ok === 'boolean';
}

/**
 * Validate a request against the frozen allowlist.
 *
 * @param {unknown} value
 * @returns {{ ok: true, request: object } | { ok: false, error: { message: string, code: string } }}
 */
export function validateRequest(value) {
  if (!isBridgeRequest(value)) {
    return {
      ok: false,
      error: {
        message: 'invalid bridge request envelope',
        code: 'invalid_envelope',
      },
    };
  }
  const req = /** @type {{ type: string, method?: string, id: string, sessionId: string, args?: unknown[] }} */ (
    value
  );
  if (!isTypeAllowed(req.type)) {
    return {
      ok: false,
      error: {
        message: `type not allowed: ${req.type}`,
        code: 'method_not_allowed',
      },
    };
  }
  const methods = METHOD_ALLOWLIST[req.type];
  if (methods !== null && !isMethodAllowed(req.type, req.method)) {
    return {
      ok: false,
      error: {
        message: `method not allowed: ${req.type}.${req.method || ''}`,
        code: 'method_not_allowed',
      },
    };
  }
  return { ok: true, request: req };
}

/**
 * Round-trip helper for tests: request → response with optional result.
 *
 * @param {ReturnType<typeof createRequest>} request
 * @param {{ ok?: boolean, result?: unknown, error?: { message?: string, code?: string } }} [outcome]
 * @returns {ReturnType<typeof createResponse>}
 */
export function respondTo(request, outcome = { ok: true, result: undefined }) {
  return createResponse({
    id: request?.id ?? '',
    ok: outcome.ok !== false,
    result: outcome.result,
    error: outcome.error,
  });
}
