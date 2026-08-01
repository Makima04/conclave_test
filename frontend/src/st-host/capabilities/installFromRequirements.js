/**
 * Map StRuntimeRequirements (backend scanner) → capability ids for install planning.
 *
 * @module st-host/capabilities/installFromRequirements
 */

/**
 * Map a required_shim name to a capability id.
 * @param {string} shim
 * @returns {string|null}
 */
export function mapShimToCapabilityId(shim) {
  const key = String(shim || '')
    .trim()
    .toLowerCase();
  if (!key) return null;

  switch (key) {
    case 'mvu':
      return 'mvu';
    case 'trigger_slash':
    case 'slash':
    case 'slash_runtime':
      return 'slash.runtime';
    case 'events':
    case 'event':
    case 'event_bus':
      return 'event.bus';
    case 'chat_messages':
    case 'chat':
    case 'tavern_helper':
    case 'th':
      return 'th.surface';
    case 'lorebook_entries':
    case 'lorebook':
      return 'th.surface';
    default:
      break;
  }

  if (key.startsWith('library:')) {
    return mapLib(key.slice('library:'.length));
  }
  if (key.startsWith('lib.')) {
    return key;
  }

  return null;
}

/**
 * Map a scanned global name (bare, window.X, parent.X) to a capability id.
 * Unknown names return null (warning only, non-blocking).
 * @param {string} g
 * @returns {string|null}
 */
export function mapGlobalToCapabilityId(g) {
  let name = String(g || '').trim();
  if (!name) return null;

  if (name.startsWith('window.') || name.startsWith('parent.')) {
    name = name.slice(name.indexOf('.') + 1);
  }
  // Strip deeper paths: SillyTavern.getContext → SillyTavern
  if (name.includes('.')) {
    name = name.split('.')[0];
  }

  switch (name) {
    case 'Mvu':
      return 'mvu';
    case '$':
    case 'jQuery':
      return 'lib.jquery';
    case '_':
    case 'lodash':
      return 'lib.lodash';
    case 'SillyTavern':
    case 'getContext':
      return 'st.context';
    case 'TavernHelper':
    case 'getChatMessages':
    case 'setChatMessages':
    case 'setChatMessage':
    case 'getCurrentMessageId':
    case 'getLorebookEntries':
    case 'setLorebookEntries':
    case 'replaceLorebookEntries':
    case 'updateLorebookEntriesWith':
    case 'createLorebookEntries':
    case 'deleteLorebookEntries':
    case 'getVariables':
    case 'replaceVariables':
    case 'updateVariablesWith':
    case 'insertOrAssignVariables':
    case 'insertVariables':
    case 'deleteVariable':
    case 'initializeGlobal':
    case 'waitGlobalInitialized':
    case 'getvar':
    case 'setvar':
    case 'errorCatched':
    case 'getScriptId':
    case 'createWorldbook':
    case 'deleteWorldbookEntries':
      return 'th.surface';
    case 'triggerSlash':
    case 'executeSlashCommands':
    case 'executeSlashCommandsWithOptions':
      return 'slash.runtime';
    case 'eventOn':
    case 'eventOnce':
    case 'eventEmit':
    case 'eventRemoveListener':
    case 'eventSource':
      return 'event.bus';
    case 'formatAsTavernRegexedString':
      return 'regex.display';
    case 'toastr':
      return null;
    default:
      return null;
  }
}

/**
 * Map a library scanner token to a capability id.
 * @param {string} lib
 * @returns {string|null}
 */
export function mapLib(lib) {
  const key = String(lib || '')
    .trim()
    .toLowerCase()
    .replace(/^lib\./, '');
  if (!key) return null;

  if (key === 'jquery' || key === 'jq' || key === '$') return 'lib.jquery';
  if (key === 'lodash' || key === '_') return 'lib.lodash';
  if (key === 'fontawesome' || key === 'font-awesome' || key === 'fa') {
    return 'lib.fontawesome';
  }
  return null;
}

/**
 * Plan which capability ids to install for a requirements blob.
 * Always includes alwaysInstallIds; merges shims, globals, libraries, slash.
 *
 * @param {object|null|undefined} requirements
 * @param {{ alwaysInstallIds?: string[] }} [options]
 * @returns {string[]}
 */
export function planInstall(requirements, { alwaysInstallIds = [] } = {}) {
  /** @type {Set<string>} */
  const ids = new Set(
    (alwaysInstallIds || []).filter((id) => typeof id === 'string' && id)
  );

  const req = requirements && typeof requirements === 'object' ? requirements : {};

  for (const shim of req.required_shims || []) {
    const id = mapShimToCapabilityId(shim);
    if (id) ids.add(id);
  }

  const globalLists = [
    ...(req.globals || []),
    ...(req.window_globals || []),
    ...(req.parent_globals || []),
  ];
  for (const g of globalLists) {
    const id = mapGlobalToCapabilityId(g);
    if (id) ids.add(id);
  }

  for (const lib of req.libraries || []) {
    const id = mapLib(lib);
    if (id) ids.add(id);
  }

  if (Array.isArray(req.slash_commands) && req.slash_commands.length) {
    ids.add('slash.runtime');
  }

  if (Array.isArray(req.events) && req.events.length) {
    ids.add('event.bus');
  }

  return [...ids];
}
