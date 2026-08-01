import $ from 'jquery';
import _ from 'lodash';
import '@fortawesome/fontawesome-free/css/all.min.css';
import './index.css';
import './App.css';
import { clone } from './shared/clone.js';
import { hasOwn } from './shared/object.js';
import {
  createScopedIndexedDB,
  createScopedLocalStorage,
} from './shared/scopedStorage.js';
import { readCardJsonFromFile } from './shared/cardFile.js';
import { extractHtmlParts } from './shared/extractHtmlParts.js';
import { createHostShell } from './shell/HostShell.js';
import { createSessionStore } from './session/SessionStore.js';
import { createSessionKernel } from './session/SessionKernel.js';
import { createWindowAdapter } from './st-host/isolation/GlobalAdapter.js';
import { createContextFactory } from './st-host/context/ContextFactory.js';
import { createEventBus } from './st-host/context/EventBus.js';
import {
  createCapabilityCatalog,
  createCapabilityRegistry,
  isStrictCapabilities,
} from './st-host/capabilities/index.js';
import {
  processDisplay,
  isDisplayRegexFeEnabled,
  regex_placement,
  createMessageMount,
} from './st-host/render/index.js';
import { createPorts } from './bridge/createPorts.js';
import { MVU_EVENTS } from './bridge/stEventMap.js';

const OPENING_SWIPE_REFRESH_DELAY_MS = 650;

/** Session truth: phase, card payload, requirements, runtime. */
const store = createSessionStore();

/** Ports for Mind / diagnostics (bridge layer; no st-host imports inside). */
const ports = createPorts({
  getRuntime: () => store.getRuntime(),
});

/**
 * UI / host-chrome state only (not session authority).
 * Session fields live on SessionStore; runtime is created solely by SessionKernel.
 */
const appState = {
  activeView: 'opening',
  openingMessageNode: null,
  sending: false,
  importing: false,
  scriptRunId: 0,
  tavernHelperRunId: 0,
  pendingRefreshTimers: new Map(),
  cardArtifactObserver: null,
  cardArtifactNodes: new Set(),
};

/** @type {ReturnType<typeof createSessionKernel> | null} */
let kernel = null;

const root = document.getElementById('root');
const shell = createHostShell({
  root,
  onReturnOpening: () => showOpeningView(),
  onImportFile: file => {
    void importCardFile(file);
  },
  onSelectWorldbook: id => {
    void selectImportedWorldbook(id);
  },
  onSend: () => {
    // Shell only delegates — no private chat fetch (PR-07 §3.3 rule 2).
    void sendUserMessage();
  },
  onSwipe: delta => {
    void changeOpeningSwipe(delta);
  },
});

/** PR-07: sole DOM projector for chat bubbles (any messageId). */
const messageMount = createMessageMount({
  getRoot: () => shell.getMessageArea() || document.getElementById('st-message-area'),
  getMessages: () => store.getMessages(),
  renderHtmlInto: (html, targetEl) => {
    renderCardHtml(html || '', targetEl);
  },
});

const hostDocumentBaseline = {
  htmlClassName: document.documentElement.className,
  htmlStyle: document.documentElement.getAttribute('style'),
  bodyClassName: document.body.className,
  bodyStyle: document.body.getAttribute('style'),
};
let domContentLoadedFired = document.readyState === 'complete';

if (!domContentLoadedFired) {
  document.addEventListener('DOMContentLoaded', () => {
    domContentLoadedFired = true;
  }, { once: true });
}

function installClassicGlobalIdentifier(name, initializerExpression) {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return;

  const script = document.createElement('script');
  script.textContent = `
    if (typeof ${name} === 'undefined') {
      var ${name} = window.${name} || (window.${name} = ${initializerExpression});
    } else if (!window.${name}) {
      window.${name} = ${name};
    }
  `;
  document.head.appendChild(script);
  script.remove();
}

function installBundledCardGlobalCompatibility() {
  // Some bundled ST card UIs keep a bare `Vue;` external marker even when the runtime is not used.
  installClassicGlobalIdentifier('Vue', '{}');
}

function installCardStorageCompatibility() {
  Object.assign(window, {
    __conclaveCreateScopedLocalStorage: createScopedLocalStorage,
    __conclaveCreateScopedIndexedDB: createScopedIndexedDB,
  });
}

function dispatchLateDomReadyListener(target, listener) {
  const event = new Event('DOMContentLoaded');
  try {
    if (typeof listener === 'function') {
      listener.call(target, event);
    } else if (listener && typeof listener.handleEvent === 'function') {
      listener.handleEvent(event);
    }
  } catch (error) {
    window.setTimeout(() => {
      throw error;
    }, 0);
  }
}

function installDomReadyCompatibility() {
  [document, window].forEach(target => {
    if (target.__conclaveDomReadyCompatInstalled) return;
    const originalAddEventListener = target.addEventListener.bind(target);
    Object.defineProperty(target, '__conclaveDomReadyCompatInstalled', { value: true });

    target.addEventListener = function addEventListener(type, listener, options) {
      const result = originalAddEventListener(type, listener, options);
      if (
        type === 'DOMContentLoaded' &&
        (domContentLoadedFired || document.readyState === 'complete') &&
        listener
      ) {
        window.setTimeout(() => dispatchLateDomReadyListener(target, listener), 0);
      }
      return result;
    };
  });
}

installBundledCardGlobalCompatibility();
installCardStorageCompatibility();
installDomReadyCompatibility();

function renderShell() {
  shell.renderShell({
    cardName: store.getCardName() || 'Conclave',
    worldbooks: store.getImportedWorldbooks(),
  });
}

function showLoading() {
  shell.showLoading();
}

function showError(message) {
  shell.showError(message);
}

function clearPendingRefreshTimers() {
  appState.pendingRefreshTimers.forEach(timer => window.clearTimeout(timer));
  appState.pendingRefreshTimers.clear();
}

function restoreElementAttribute(element, name, value) {
  if (value === null || value === undefined || value === '') element.removeAttribute(name);
  else element.setAttribute(name, value);
}

function restoreHostDocumentState() {
  document.documentElement.className = hostDocumentBaseline.htmlClassName || '';
  restoreElementAttribute(document.documentElement, 'style', hostDocumentBaseline.htmlStyle);
  document.body.className = hostDocumentBaseline.bodyClassName || '';
  restoreElementAttribute(document.body, 'style', hostDocumentBaseline.bodyStyle);
}

function isInsideHostRoot(node) {
  if (!root || node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node;
  return element === root || root.contains(element) || element.contains(root);
}

function rememberCardArtifact(node) {
  if (node.nodeType !== Node.ELEMENT_NODE || isInsideHostRoot(node)) return;
  appState.cardArtifactNodes.add(node);
}

function cleanupCardArtifacts() {
  appState.cardArtifactObserver?.disconnect();
  appState.cardArtifactObserver = null;

  appState.cardArtifactNodes.forEach(node => {
    if (node.isConnected) node.remove();
  });
  appState.cardArtifactNodes.clear();

  document
    .querySelectorAll('[data-conclave-card-head="true"], script[data-conclave-card-script]')
    .forEach(node => node.remove());
  restoreHostDocumentState();
}

function beginCardArtifactTracking() {
  appState.cardArtifactObserver?.disconnect();
  const observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(rememberCardArtifact);
    });
  });
  observer.observe(document.head, { childList: true });
  observer.observe(document.body, { childList: true });
  appState.cardArtifactObserver = observer;
}

/**
 * @deprecated Use kernel.loadFromInitResponse — kept as thin alias for readability at call sites.
 * @param {import('./session/types.js').InitResponseData} data
 * @returns {Promise<void>}
 */
async function applyInitData(data) {
  if (!kernel) throw new Error('[SessionKernel] kernel not initialized');
  appState.activeView = 'opening';
  appState.openingMessageNode = null;
  await kernel.loadFromInitResponse(data);
}

function updateShellViewState() {
  shell.updateWorldbookActive(store.getCurrentWorldbookId());
}

function showOpeningView() {
  const messageArea = shell.getMessageArea();
  if (!messageArea) return;

  appState.activeView = 'opening';
  appState.openingMessageNode = null;

  // Project only opening (messageId 0) via MessageMount — same renderer as chat turns.
  messageMount.teardown();
  messageMount.bind(messageArea);

  const runtime = ensureRuntime();
  const message = runtime.runtimeState.messages[0];
  if (message) {
    const swipeId = Number.isFinite(Number(message.swipe_id)) ? Number(message.swipe_id) : 0;
    const raw =
      (Array.isArray(message.swipes) ? message.swipes[swipeId] : '') || message.message || '';
    const backendHint = Array.isArray(message.rendered_swipes)
      ? message.rendered_swipes[swipeId] || ''
      : store.getOpeningRenderedMessages()[0] || '';
    const html = renderDisplayHtml(raw, backendHint);
    if (Array.isArray(message.rendered_swipes)) {
      message.rendered_swipes[swipeId] = html;
    }
  }

  messageMount.refresh(0);
  appState.openingMessageNode = messageMount.getNode(0);
  renderOpeningSwipeControls();
  updateShellViewState();
}

function getOpeningSwipeState() {
  const runtime = ensureRuntime();
  const message = runtime.runtimeState.messages[0];
  const count = Math.max(
    Array.isArray(message?.swipes) ? message.swipes.length : 0,
    Array.isArray(message?.rendered_swipes) ? message.rendered_swipes.length : 0,
    store.getOpeningRawMessages().length,
    1
  );
  const current = Number.isFinite(Number(message?.swipe_id)) ? Number(message.swipe_id) : 0;
  return {
    count,
    current: Math.min(Math.max(current, 0), count - 1),
  };
}

function renderOpeningSwipeControls() {
  if (appState.activeView !== 'opening') {
    shell.clearOpeningSwipeControls();
    return;
  }
  const { count, current } = getOpeningSwipeState();
  shell.renderOpeningSwipeControls({ count, current });
}

async function changeOpeningSwipe(delta) {
  const { count, current } = getOpeningSwipeState();
  if (count <= 1 || !Number.isFinite(delta)) return;
  const next = (current + Math.trunc(delta) + count) % count;
  await window.setChatMessages?.([{ message_id: 0, swipe_id: next }], { refresh: 'none' });
  refreshDisplayedMessage(0);
}

async function selectImportedWorldbook(importId) {
  if (!Number.isFinite(importId)) return;
  if (importId === store.getCurrentWorldbookId()) {
    showOpeningView();
    return;
  }

  try {
    const response = await fetch('/api/select-card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ import_id: importId }),
    });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    await applyInitData(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    kernel?.fail?.(message, { showUi: false });
    showError(message);
  }
}

function installHeadNodes(headNodes) {
  if (!headNodes.length) return;

  document.querySelectorAll('[data-conclave-card-head="true"]').forEach(node => node.remove());

  headNodes.forEach(node => {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node;
    if (element.tagName === 'SCRIPT') return;
    if (
      element.tagName === 'LINK' &&
      /font-?awesome/i.test(element.getAttribute('href') || '')
    ) {
      return;
    }
    element.setAttribute('data-conclave-card-head', 'true');
    document.head.appendChild(element);
  });
}

async function importCardFile(file) {
  if (appState.importing) return;
  appState.importing = true;
  setImportControlsDisabled(true);

  try {
    const cardJson = await readCardJsonFromFile(file);
    const response = await fetch('/api/import-card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_json: cardJson }),
    });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    await applyInitData(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    kernel?.fail?.(message, { showUi: false });
    showError(message);
  } finally {
    appState.importing = false;
    setImportControlsDisabled(false);
  }
}

function setImportControlsDisabled(disabled) {
  shell.setImportControlsDisabled(disabled);
}

function buildOpeningMvuData(message, defaultMvuData) {
  const parsedStatData = [
    parseInitVarStatData(message),
    parseUpdateVariableStatData(message),
  ].filter(value => value && Object.keys(value).length).reduce(
    (merged, value) => _.mergeWith(merged, value, (_lhs, rhs) => (_.isArray(rhs) ? rhs : undefined)),
    {}
  );

  if (!Object.keys(parsedStatData).length) return clone(defaultMvuData);
  return _.mergeWith(
    clone(defaultMvuData),
    { stat_data: parsedStatData },
    (_lhs, rhs) => (_.isArray(rhs) ? rhs : undefined)
  );
}

function parseInitVarStatData(message) {
  const match = String(message || '').match(/<initvar>\s*([\s\S]*?)\s*<\/initvar>/i);
  if (!match) return null;
  const parsed = parseIndentedKeyValueBlock(match[1]);
  return parsed && Object.keys(parsed).length ? parsed : null;
}

function parseUpdateVariableStatData(message) {
  const source = String(message || '');
  const root = {};
  const blocks = source.matchAll(/<UpdateVariable>\s*([\s\S]*?)\s*<\/UpdateVariable>/gi);

  for (const block of blocks) {
    extractFunctionCallArguments(block[1], '_.set').forEach(argumentSource => {
      const args = splitJsArguments(argumentSource).map(parseJsArgument);
      const path = args[0];
      if (typeof path !== 'string' || !path.trim() || args.length < 2) return;

      const previousValue = args.length >= 3 ? args[1] : undefined;
      const currentValue = args.length >= 3 ? args[2] : args[1];
      _.set(root, path, args.length >= 3 ? [currentValue, previousValue] : currentValue);
    });
  }

  return Object.keys(root).length ? root : null;
}

function extractFunctionCallArguments(source, functionName) {
  const calls = [];
  let index = 0;

  while (index < source.length) {
    const start = source.indexOf(`${functionName}(`, index);
    if (start < 0) break;

    let cursor = start + functionName.length;
    let depth = 0;
    let quote = null;
    let escaped = false;
    let argumentStart = cursor + 1;

    for (; cursor < source.length; cursor += 1) {
      const char = source[cursor];

      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = null;
        continue;
      }

      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        continue;
      }
      if (char === '(') {
        depth += 1;
        continue;
      }
      if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          calls.push(source.slice(argumentStart, cursor));
          cursor += 1;
          break;
        }
      }
    }

    index = cursor;
  }

  return calls;
}

function splitJsArguments(source) {
  const args = [];
  let current = '';
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (const char of source) {
    if (quote) {
      current += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(depth - 1, 0);
      current += char;
      continue;
    }
    if (char === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) args.push(current.trim());
  return args;
}

function parseJsArgument(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('`') && trimmed.endsWith('`'))
  ) {
    return parseJsStringLiteral(trimmed);
  }
  return parseScalarValue(trimmed);
}

function parseJsStringLiteral(value) {
  const quote = value[0];
  let output = '';

  for (let index = 1; index < value.length - 1; index += 1) {
    const char = value[index];
    if (char !== '\\') {
      output += char;
      continue;
    }

    index += 1;
    if (index >= value.length - 1) break;
    const escaped = value[index];
    if (escaped === quote || escaped === '\\') output += escaped;
    else if (escaped === 'n') output += '\n';
    else if (escaped === 'r') output += '\r';
    else if (escaped === 't') output += '\t';
    else if (escaped === 'b') output += '\b';
    else if (escaped === 'f') output += '\f';
    else if (escaped === 'v') output += '\v';
    else if (escaped === '0') output += '\0';
    else if (escaped === 'x' && index + 2 < value.length - 1) {
      const hex = value.slice(index + 1, index + 3);
      output += String.fromCharCode(Number.parseInt(hex, 16));
      index += 2;
    } else if (escaped === 'u' && index + 4 < value.length - 1) {
      const hex = value.slice(index + 1, index + 5);
      output += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
    } else {
      output += escaped;
    }
  }

  return output;
}

function parseIndentedKeyValueBlock(source) {
  const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
  const root = {};
  const stack = [{ indent: -1, value: root }];

  lines.forEach((rawLine, index) => {
    if (!rawLine.trim()) return;
    const indent = rawLine.match(/^\s*/)?.[0].length || 0;
    const text = rawLine.trim();
    if (!text || /^<\/?[^>]+>$/.test(text)) return;

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].value;

    if (text.startsWith('- ')) {
      if (!Array.isArray(parent)) return;
      parent.push(parseScalarValue(text.slice(2)));
      return;
    }

    const colonIndex = text.indexOf(':');
    if (colonIndex < 0) return;

    const key = text.slice(0, colonIndex).trim();
    const rawValue = text.slice(colonIndex + 1).trim();
    if (!key) return;

    if (rawValue) {
      assignParsedValue(parent, key, parseScalarValue(rawValue));
      return;
    }

    const next = findNextMeaningfulLine(lines, index + 1);
    const child = next && next.indent > indent && next.text.startsWith('- ') ? [] : {};
    assignParsedValue(parent, key, child);
    stack.push({ indent, value: child });
  });

  return root;
}

function assignParsedValue(parent, key, value) {
  if (Array.isArray(parent)) parent.push({ [key]: value });
  else parent[key] = value;
}

function findNextMeaningfulLine(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    return {
      indent: line.match(/^\s*/)?.[0].length || 0,
      text: line.trim(),
    };
  }
  return null;
}

function parseScalarValue(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (trimmed === '{}') return {};
  if (trimmed === '[]') return [];
  if (/^(true|false)$/i.test(trimmed)) return /^true$/i.test(trimmed);
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function createRuntime() {
  const defaultMvuData = {
    initialized_lorebooks: {},
    stat_data: {},
  };
  const importedLorebookEntries = store.getWorldbookEntries().map(entry => ({
    uid: entry.id ?? entry.index + 1,
    id: entry.id ?? entry.index + 1,
    display_index: entry.insertion_order ?? entry.index,
    comment: entry.comment || `条目 ${entry.index + 1}`,
    enabled: !!entry.enabled,
    constant: !!entry.constant,
    selective: !!entry.selective,
    keys: clone(entry.keys || []),
    secondary_keys: clone(entry.secondary_keys || []),
    content: entry.content || '',
  }));
  const defaultLorebookEntries = importedLorebookEntries;
  const openingRawMessages = store.getOpeningRawMessages().length ? store.getOpeningRawMessages() : [''];
  const openingRenderedMessages = store.getOpeningRenderedMessages().length
    ? store.getOpeningRenderedMessages()
    : [''];
  const openingSwipeCount = Math.max(openingRawMessages.length, openingRenderedMessages.length, 1);
  const openingSwipes = Array.from({ length: openingSwipeCount }, (_, index) =>
    openingRawMessages[index] ?? openingRenderedMessages[index] ?? ''
  );
  // PR-06: prefer FE processDisplay when feature flag is on; fall back to backend rendered_* hints.
  const openingRenderedSwipes = Array.from({ length: openingSwipeCount }, (_, index) =>
    renderDisplayHtml(
      openingRawMessages[index] ?? '',
      openingRenderedMessages[index] ?? '',
    )
  );
  const openingSwipeData = Array.from({ length: openingSwipeCount }, (_, index) =>
    buildOpeningMvuData(openingSwipes[index], defaultMvuData)
  );
  const openingSwipeInfo = Array.from({ length: openingSwipeCount }, () => ({}));
  const initialMvuData = clone(openingSwipeData[0] || defaultMvuData);
  const cardName = store.getCardName() || '当前角色卡世界书';
  const runtimeState = {
    mvuData: clone(initialMvuData),
    messages: [{
      message_id: 0,
      name: 'assistant',
      role: 'assistant',
      is_hidden: false,
      message: openingSwipes[0] || '',
      data: clone(initialMvuData),
      extra: {},
      swipe_id: 0,
      swipes: openingSwipes,
      rendered_swipes: openingRenderedSwipes,
      swipes_data: openingSwipeData,
      swipes_info: openingSwipeInfo,
    }],
    lorebooks: {
      [cardName]: clone(defaultLorebookEntries),
    },
    variables: {
      chat: {},
      character: {},
      global: {},
      preset: {},
      script: {},
      extension: {},
    },
  };
  // PR-05: shared EventBus for TH eventOn/eventEmit and getContext().eventSource
  const eventBus = createEventBus({
    thisArg: typeof window !== 'undefined' ? window : undefined,
  });
  const { eventOn, eventOnce, eventEmit, eventRemoveListener } = eventBus;
  const eventSourceApi = eventBus.asEventSource();

  function normalizeMessageId(messageId) {
    if (messageId === 'latest') return runtimeState.messages.length - 1;
    const numeric = Number(messageId);
    return numeric < 0 ? runtimeState.messages.length + numeric : numeric;
  }

  function normalizeSwipeIndex(swipeId, length) {
    const numeric = Number(swipeId);
    if (!Number.isFinite(numeric)) return 0;
    return Math.min(Math.max(Math.trunc(numeric), 0), Math.max(length - 1, 0));
  }

  function normalizeSwipeArrays(message) {
    const maxLength = Math.max(
      Array.isArray(message.swipes) ? message.swipes.length : 0,
      Array.isArray(message.rendered_swipes) ? message.rendered_swipes.length : 0,
      Array.isArray(message.swipes_data) ? message.swipes_data.length : 0,
      Array.isArray(message.swipes_info) ? message.swipes_info.length : 0,
      1
    );
    message.swipes = Array.from({ length: maxLength }, (_, index) => message.swipes?.[index] ?? '');
    message.rendered_swipes = Array.from({ length: maxLength }, (_, index) => message.rendered_swipes?.[index] ?? '');
    message.swipes_data = Array.from({ length: maxLength }, (_, index) =>
      message.swipes_data?.[index] ?? buildOpeningMvuData(message.swipes?.[index], defaultMvuData)
    );
    message.swipes_info = Array.from({ length: maxLength }, (_, index) => message.swipes_info?.[index] ?? {});
    message.swipe_id = normalizeSwipeIndex(message.swipe_id, maxLength);
    message.message = message.swipes[message.swipe_id] || message.message || '';
    message.data = message.swipes_data[message.swipe_id] || message.data || {};
    message.extra = message.swipes_info[message.swipe_id] || message.extra || {};
  }

  function getMessageVariables(option = {}) {
    const messageId = normalizeMessageId(option.message_id ?? 'latest');
    const message = runtimeState.messages[messageId];
    if (!message) return {};
    normalizeSwipeArrays(message);
    return message.swipes_data[message.swipe_id] || {};
  }

  function replaceMessageVariables(variables, option = {}) {
    const messageId = normalizeMessageId(option.message_id ?? 'latest');
    if (!runtimeState.messages[messageId]) return;
    const message = runtimeState.messages[messageId];
    normalizeSwipeArrays(message);
    const nextVariables = clone(variables) || {};
    message.swipes_data[message.swipe_id] = nextVariables;
    message.data = nextVariables;
    if (messageId === runtimeState.messages.length - 1) {
      runtimeState.mvuData = clone(nextVariables);
    }
  }

  function getVariableBucket(option = { type: 'chat' }) {
    const type = option.type || 'chat';
    if (type === 'message') return getMessageVariables(option);
    if (type === 'script') {
      const id = option.script_id || 'default';
      runtimeState.variables.script[id] = runtimeState.variables.script[id] || {};
      return runtimeState.variables.script[id];
    }
    if (type === 'extension') {
      const id = option.extension_id || 'default';
      runtimeState.variables.extension[id] = runtimeState.variables.extension[id] || {};
      return runtimeState.variables.extension[id];
    }
    runtimeState.variables[type] = runtimeState.variables[type] || {};
    return runtimeState.variables[type];
  }

  function getChatMessages(range, options) {
    const includeSwipes = !!(options && options.include_swipes);
    const messageId = normalizeMessageId(range);
    const message = runtimeState.messages[messageId];
    if (!message) return [];
    if (includeSwipes) {
      return [clone({
        message_id: messageId,
        name: message.name,
        role: message.role,
        is_hidden: message.is_hidden,
        swipe_id: message.swipe_id || 0,
        swipes: message.swipes || [message.message || ''],
        swipes_data: message.swipes_data || [message.data || {}],
        swipes_info: message.swipes_info || [message.extra || {}],
      })];
    }
    return [clone(message)];
  }

  function getCurrentMessageId() {
    return Math.max(runtimeState.messages.length - 1, 0);
  }

  function getVariables(option = { type: 'chat' }) {
    return clone(getVariableBucket(option));
  }

  function replaceVariables(variables, option = { type: 'chat' }) {
    if ((option.type || 'chat') === 'message') {
      replaceMessageVariables(variables, option);
      return;
    }

    const type = option.type || 'chat';
    if (type === 'script') {
      runtimeState.variables.script[option.script_id || 'default'] = clone(variables) || {};
      return;
    }
    if (type === 'extension') {
      runtimeState.variables.extension[option.extension_id || 'default'] = clone(variables) || {};
      return;
    }
    runtimeState.variables[type] = clone(variables) || {};
  }

  function updateVariablesWith(updater, option = { type: 'chat' }) {
    const current = getVariables(option);
    const result = updater(current);
    if (result && typeof result.then === 'function') {
      return result.then(nextVariables => {
        replaceVariables(nextVariables, option);
        return nextVariables;
      });
    }
    replaceVariables(result, option);
    return result;
  }

  function insertOrAssignVariables(variables, option = { type: 'chat' }) {
    return updateVariablesWith(
      current => _.mergeWith(current, variables, (_lhs, rhs) => (_.isArray(rhs) ? rhs : undefined)),
      option
    );
  }

  function insertVariables(variables, option = { type: 'chat' }) {
    return updateVariablesWith(
      current => _.mergeWith({}, variables, current, (_lhs, rhs) => (_.isArray(rhs) ? rhs : undefined)),
      option
    );
  }

  function deleteVariable(variablePath, option = { type: 'chat' }) {
    let deleteOccurred = false;
    const variables = updateVariablesWith(current => {
      deleteOccurred = _.unset(current, variablePath);
      return current;
    }, option);
    return { variables, delete_occurred: deleteOccurred };
  }

  async function setChatMessages(chatMessages, options = {}) {
    const affectedRefreshDelays = new Map();

    (chatMessages || []).forEach(update => {
      const messageId = normalizeMessageId(update.message_id);
      if (!runtimeState.messages[messageId]) {
        runtimeState.messages[messageId] = {
          message_id: messageId,
          role: 'assistant',
          name: 'assistant',
          is_hidden: false,
          message: '',
          data: {},
          extra: {},
          swipe_id: 0,
          swipes: [''],
          rendered_swipes: [''],
          swipes_data: [{}],
          swipes_info: [{}],
        };
      }
      const current = runtimeState.messages[messageId];
      const next = clone(update);
      delete next.message_id;
      const oldData = clone(current.data || {});
      const isOpeningSwipeOnlyUpdate =
        messageId === 0 &&
        next.swipe_id !== undefined &&
        ![
          'message',
          'swipes',
          'swipes_data',
          'swipes_info',
          'data',
          'extra',
          'name',
          'role',
          'is_hidden',
        ].some(key => hasOwn(next, key));

      normalizeSwipeArrays(current);

      if (next.swipes) current.swipes = clone(next.swipes);
      if (next.swipes_data) current.swipes_data = clone(next.swipes_data);
      if (next.swipes_info) current.swipes_info = clone(next.swipes_info);
      if (next.name !== undefined) current.name = next.name;
      if (next.role !== undefined) current.role = next.role;
      if (next.is_hidden !== undefined) current.is_hidden = next.is_hidden;

      const requestedSwipeId = next.swipe_id !== undefined ? next.swipe_id : current.swipe_id;
      current.swipe_id = normalizeSwipeIndex(requestedSwipeId, Math.max(current.swipes?.length || 1, 1));

      if (next.message !== undefined) {
        current.message = next.message;
        current.swipes[current.swipe_id] = next.message;
        current.rendered_swipes[current.swipe_id] = '';
      }
      if (next.data !== undefined) {
        current.data = clone(next.data);
        current.swipes_data[current.swipe_id] = clone(next.data);
      }
      if (next.extra !== undefined) {
        current.extra = clone(next.extra);
        current.swipes_info[current.swipe_id] = clone(next.extra);
      }

      normalizeSwipeArrays(current);
      if (messageId === runtimeState.messages.length - 1) {
        runtimeState.mvuData = clone(current.data || {});
        if (!_.isEqual(oldData, current.data || {})) {
          void eventEmitWithDom(Mvu.events.VARIABLE_UPDATE_ENDED, runtimeState.mvuData, oldData);
        }
      }
      affectedRefreshDelays.set(
        messageId,
        Math.max(
          affectedRefreshDelays.get(messageId) || 0,
          isOpeningSwipeOnlyUpdate ? OPENING_SWIPE_REFRESH_DELAY_MS : 0
        )
      );
    });

    if ((options.refresh || 'affected') !== 'none') {
      affectedRefreshDelays.forEach((delayMs, messageId) =>
        scheduleDisplayedMessageRefresh(messageId, delayMs)
      );
    }
  }

  async function setChatMessage(message, messageId, options) {
    const fieldValues = typeof message === 'string' ? { message } : clone(message) || {};
    const swipeId = options && typeof options.swipe_id === 'number' ? options.swipe_id : undefined;
    await setChatMessages([{ message_id: messageId, ...fieldValues, swipe_id: swipeId }], {
      refresh: options && options.refresh === 'none' ? 'none' : 'affected',
    });
  }

  async function getLorebookEntries(lorebook) {
    if (!runtimeState.lorebooks[lorebook]) runtimeState.lorebooks[lorebook] = [];
    return clone(runtimeState.lorebooks[lorebook]);
  }

  async function setLorebookEntries(lorebook, entries) {
    const current = await getLorebookEntries(lorebook);
    (entries || []).forEach(entry => {
      const index = current.findIndex(item =>
        (entry.uid !== undefined && item.uid === entry.uid) ||
        (entry.id !== undefined && item.id === entry.id) ||
        (entry.comment && item.comment === entry.comment)
      );
      if (index >= 0) current[index] = _.merge({}, current[index], entry);
      else current.push(_.merge({}, entry, { uid: entry.uid || current.length + 1 }));
    });
    runtimeState.lorebooks[lorebook] = current;
    return clone(current);
  }

  async function triggerSlash(command) {
    console.log('[ConclaveSTHost] slash command:', command);
    if (String(command).startsWith('/echo')) return '';
    if (String(command).startsWith('/trigger')) return '';
    return '';
  }

  /** Wrap EventBus emit so DOM custom events still fire for legacy listeners. */
  async function eventEmitWithDom(event, ...args) {
    await eventEmit(event, ...args);
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('conclave:variables-updated', { detail: { event, args } }));
    }
  }

  function initializeGlobal(globalName, value) {
    _.set(window, globalName, value);
    void eventEmitWithDom(`global_${globalName}_initialized`, value);
  }

  async function waitGlobalInitialized(globalName) {
    if (_.has(window, globalName)) return _.get(window, globalName);
    return new Promise(resolve => {
      eventOnce(`global_${globalName}_initialized`, value => resolve(value));
    });
  }

  /**
   * PR-06: real display regex via FE RenderPipeline (AI_OUTPUT).
   * Falls back to identity when feature flag is off.
   * @param {string} text
   * @param {number} [placement]
   * @param {{ depth?: number, isEdit?: boolean }} [options]
   */
  function formatAsTavernRegexedString(text, placement, options = {}) {
    if (!isDisplayRegexFeEnabled()) {
      return String(text ?? '');
    }
    return processDisplay(String(text ?? ''), store.getRegexScripts(), {
      placement: placement ?? regex_placement.AI_OUTPUT,
      depth: options.depth,
      isEdit: !!options.isEdit,
      hasTavernHelperScripts: store.getTavernHelperScripts().length > 0,
    });
  }

  const Mvu = {
    events: { ...MVU_EVENTS },
    getMvuData(options = { type: 'message', message_id: 'latest' }) {
      return getVariables(options);
    },
    async replaceMvuData(mvuData, options = { type: 'message', message_id: 'latest' }) {
      const oldData = clone(runtimeState.mvuData || {});
      replaceVariables(mvuData, options);
      runtimeState.mvuData = clone(mvuData);
      void eventEmitWithDom(Mvu.events.VARIABLE_UPDATE_ENDED, runtimeState.mvuData, oldData);
    },
    async parseMessage(_message, oldData) {
      // Stub: full MagVarUpdate parse lands later; surface is ready subset.
      return clone(oldData);
    },
    isDuringExtraAnalysis() {
      return false;
    },
  };

  const TavernHelper = {
    triggerSlash,
    getCurrentMessageId,
    getChatMessages,
    setChatMessages,
    setChatMessage,
    getLorebookEntries,
    setLorebookEntries,
    getVariables,
    replaceVariables,
    updateVariablesWith,
    insertOrAssignVariables,
    insertVariables,
    deleteVariable,
    initializeGlobal,
    waitGlobalInitialized,
    formatAsTavernRegexedString,
    eventOn,
    eventOnce,
    eventEmit: eventEmitWithDom,
    eventRemoveListener,
  };

  // PR-04: real getContext() via ContextFactory — NEVER returns TavernHelper.
  const contextFactory = createContextFactory({
    getRuntimeState: () => runtimeState,
    getCardName: () => cardName,
    getUserName: () => 'User',
    getEventSource: () => eventSourceApi,
    getEventTypes: () => Mvu.events,
  });

  // PR-04: all session globals go through GlobalAdapter for tracked teardown.
  const adapter = createWindowAdapter(window);
  const define = (path, value) => adapter.defineGlobal(path, value);

  define('$', $);
  define('jQuery', $);
  define('_', _);
  define('lodash', _);
  define('triggerSlash', triggerSlash);
  define('getCurrentMessageId', getCurrentMessageId);
  define('getChatMessages', getChatMessages);
  define('setChatMessages', setChatMessages);
  define('setChatMessage', setChatMessage);
  define('getLorebookEntries', getLorebookEntries);
  define('setLorebookEntries', setLorebookEntries);
  define('getVariables', getVariables);
  define('replaceVariables', replaceVariables);
  define('updateVariablesWith', updateVariablesWith);
  define('insertOrAssignVariables', insertOrAssignVariables);
  define('insertVariables', insertVariables);
  define('deleteVariable', deleteVariable);
  define('initializeGlobal', initializeGlobal);
  define('waitGlobalInitialized', waitGlobalInitialized);
  define('formatAsTavernRegexedString', formatAsTavernRegexedString);
  define('eventOn', eventOn);
  define('eventOnce', eventOnce);
  define('eventEmit', eventEmitWithDom);
  define('eventRemoveListener', eventRemoveListener);
  define('eventSource', eventSourceApi);
  define('Mvu', Mvu);
  define('TavernHelper', TavernHelper);
  define('SillyTavern', {
    getContext: () => contextFactory.getContext(),
  });

  const surfaces = {
    jquery: $,
    lodash: _,
    tavernHelper: TavernHelper,
    mvu: Mvu,
    eventApi: {
      eventOn,
      eventOnce,
      eventEmit: eventEmitWithDom,
      eventRemoveListener,
    },
    contextFactory,
    triggerSlash,
    formatAsTavernRegexedString,
    // PR-06: mark regex.display ready when FE pipeline is enabled.
    regexPipeline: isDisplayRegexFeEnabled(),
    storageReady: true,
  };

  return {
    runtimeState,
    triggerSlash,
    eventEmit: eventEmitWithDom,
    eventBus,
    adapter,
    contextFactory,
    surfaces,
  };
}

/**
 * PR-04: plan + install capabilities against surfaces from createRuntime.
 * Strict mode (default): missing required_shims / requiredByDefault → ok:false.
 *
 * @param {object|null} requirements
 * @param {import('./session/types.js').SessionRuntime} runtime
 * @returns {Promise<{ ok: boolean, report: object, registry: object }>}
 */
async function installCapabilities(requirements, runtime) {
  const adapter = runtime?.adapter || createWindowAdapter(window);
  const catalog = createCapabilityCatalog({
    adapter,
    surfaces: runtime?.surfaces || {},
  });
  const registry = createCapabilityRegistry({
    catalog,
    adapter,
    strict: isStrictCapabilities(),
  });
  runtime.capabilityRegistry = registry;

  // Surfaces were already defined in createRuntime; catalog install re-binds / reports status.
  const report = await registry.install(requirements);
  return { ok: report.ok, report, registry };
}

/**
 * Return the Kernel-owned runtime. Does **not** create — createRuntime runs only
 * once on the enter-running path inside SessionKernel.loadFromInitResponse.
 * @returns {import('./session/types.js').SessionRuntime}
 */
function ensureRuntime() {
  const runtime = store.getRuntime();
  if (!runtime) {
    throw new Error(
      '[SessionKernel] runtime unavailable — create only via Kernel enter-running path'
    );
  }
  return runtime;
}

async function executeTavernHelperScripts() {
  const runId = ++appState.tavernHelperRunId;
  const scripts = store.getTavernHelperScripts().filter(script => String(script.content || '').trim());
  if (!scripts.length) return;

  ensureRuntime();

  for (const scriptPart of scripts) {
    if (runId !== appState.tavernHelperRunId) return;
    const label = scriptPart.name || `TavernHelper script ${scriptPart.index ?? ''}`;
    const source = `${scriptPart.content}\n//# sourceURL=conclave-tavern-helper-${runId}-${scriptPart.index ?? 'script'}.mjs`;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));

    try {
      await import(/* @vite-ignore */ url);
      console.debug('[ConclaveSTHost] TavernHelper script loaded:', label);
    } catch (error) {
      console.warn('[ConclaveSTHost] TavernHelper script failed:', label, error);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const liveRuntime = store.getRuntime();
  if (runId === appState.tavernHelperRunId && liveRuntime) {
    const data = clone(liveRuntime.runtimeState.mvuData || {});
    await liveRuntime.eventEmit?.(window.Mvu?.events?.VARIABLE_UPDATE_ENDED || 'mag_variable_update_ended', data, data);
  }
}

function executeScripts(scripts) {
  const runId = ++appState.scriptRunId;
  scripts.forEach(scriptPart => {
    if (scriptPart.src && /jquery/i.test(scriptPart.src)) return;
    const script = document.createElement('script');
    script.dataset.conclaveCardScript = String(runId);
    if (scriptPart.type) script.type = scriptPart.type;
    if (scriptPart.src) script.src = scriptPart.src;
    else script.textContent = cardScriptContentWithCompatibilityPrelude(scriptPart);
    document.body.appendChild(script);
  });
}

function cardScriptContentWithCompatibilityPrelude(scriptPart) {
  const content = scriptPart.content || '';
  if (!String(scriptPart.type || '').includes('module') || !/\b(?:localStorage|indexedDB)\b/.test(content)) {
    return content;
  }

  const cardKey = `${store.getCurrentWorldbookId() ?? 'current'}:${store.getCardName() || 'default'}`;
  const namespace = JSON.stringify(`conclave:card:${cardKey}:`);

  return `
    const localStorage = window.__conclaveCreateScopedLocalStorage(${namespace});
    const indexedDB = window.__conclaveCreateScopedIndexedDB(${namespace});
    const BroadcastChannel = window.BroadcastChannel
      ? class ConclaveScopedBroadcastChannel extends window.BroadcastChannel {
        constructor(name) {
          super(${namespace} + 'BroadcastChannel:' + String(name));
        }
      }
      : undefined;
    ${content}
  `;
}

function renderCardHtml(htmlContent, target) {
  const { headNodes, bodyHtml, scripts } = extractHtmlParts(htmlContent);
  installHeadNodes(headNodes);
  ensureRuntime();
  target.innerHTML = bodyHtml;
  executeScripts(scripts);
}

/**
 * PR-06: FE processDisplay when enabled; otherwise backend rendered_* hint / raw.
 * @param {string} raw
 * @param {string} [backendHint]
 * @returns {string}
 */
function renderDisplayHtml(raw, backendHint = '') {
  if (isDisplayRegexFeEnabled()) {
    const html = processDisplay(raw || '', store.getRegexScripts(), {
      placement: regex_placement.AI_OUTPUT,
      hasTavernHelperScripts: store.getTavernHelperScripts().length > 0,
    });
    // Fall back to backend hint if FE produced empty but backend had content.
    if (html) return html;
    if (backendHint) return backendHint;
    return '';
  }
  return backendHint || raw || '';
}

function scheduleDisplayedMessageRefresh(messageId, delayMs = 0) {
  const existingTimer = appState.pendingRefreshTimers.get(messageId);
  if (existingTimer) {
    window.clearTimeout(existingTimer);
    appState.pendingRefreshTimers.delete(messageId);
  }

  if (delayMs > 0) {
    const timer = window.setTimeout(() => {
      appState.pendingRefreshTimers.delete(messageId);
      refreshDisplayedMessage(messageId);
    }, delayMs);
    appState.pendingRefreshTimers.set(messageId, timer);
    return;
  }

  refreshDisplayedMessage(messageId);
}

/**
 * PR-07: refresh any messageId via MessageMount (not only opening id 0).
 * @param {number} messageId
 */
function refreshDisplayedMessage(messageId) {
  const runtime = store.getRuntime();
  if (!runtime) return;

  const id = Number(messageId);
  const message = runtime.runtimeState.messages[id];
  if (!message) return;

  const swipeId = Number.isFinite(Number(message.swipe_id)) ? Number(message.swipe_id) : 0;
  const raw =
    (Array.isArray(message.swipes) ? message.swipes[swipeId] : '') ||
    message.message ||
    '';
  const backendHint = Array.isArray(message.rendered_swipes)
    ? message.rendered_swipes[swipeId] || ''
    : '';
  const html = renderDisplayHtml(raw, backendHint);
  // Keep rendered_swipes cache in sync for MessageMount + FE pipeline.
  if (Array.isArray(message.rendered_swipes)) {
    message.rendered_swipes[swipeId] = html;
  }

  const messageArea = shell.getMessageArea();
  if (messageArea) messageMount.bind(messageArea);
  messageMount.refresh(id);

  if (id === 0) {
    appState.openingMessageNode = messageMount.getNode(0);
    renderOpeningSwipeControls();
  }
}

/**
 * When leaving opening-only view for a chat turn, re-project full Session transcript
 * so DOM bubble count matches messages.length (PR-07 rule 4).
 */
function leaveOpeningForChat() {
  if (appState.activeView === 'opening') {
    appState.activeView = 'chat';
    const messageArea = shell.getMessageArea();
    if (messageArea) messageMount.bind(messageArea);
    messageMount.renderAll();
    shell.clearOpeningSwipeControls();
  }
}

/**
 * Shell entry: read input, clear, delegate to kernel.sendUserMessage only.
 * No private fetch — all network lives in SessionKernel (PR-07).
 */
async function sendUserMessage() {
  const input = shell.getUserInput();
  const message = input?.value.trim();
  if (!message || appState.sending || !kernel) return;

  shell.clearUserInput();

  try {
    await kernel.sendUserMessage(message);
  } catch (error) {
    // Kernel onSendError already surfaces UI; ensure we don't leave unhandled rejection.
    console.warn('[ConclaveSTHost] sendUserMessage failed:', error);
  }
}

async function init() {
  showLoading();
  try {
    const response = await fetch('/api/init');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    await applyInitData(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    kernel?.fail?.(message, { showUi: false });
    showError(message);
  }
}

kernel = createSessionKernel({
  store,
  shell,
  createRuntime,
  lifecycle: ports.lifecycle,
  ports,
  messageMount,
  chatApi: async body => {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  },
  hooks: {
    clearPendingRefreshTimers,
    cleanupCardArtifacts,
    onTeardown() {
      // Invalidate in-flight TH scripts and drop opening DOM handles.
      appState.tavernHelperRunId += 1;
      appState.scriptRunId += 1;
      appState.activeView = 'opening';
      appState.openingMessageNode = null;
      messageMount.teardown();
    },
    renderShell,
    beginCardArtifactTracking,
    showOpeningView,
    executeTavernHelperScripts,
    showError,
    installCapabilities,
    isSending: () => appState.sending,
    setSending(sending) {
      appState.sending = !!sending;
      shell.setSending(!!sending);
    },
    onSendError(error) {
      const messageArea = shell.getMessageArea();
      if (!messageArea) return;
      const node = document.createElement('div');
      node.className = 'st-error-message';
      node.textContent = `发送失败: ${error instanceof Error ? error.message : String(error)}`;
      messageArea.appendChild(node);
    },
    renderAssistantDisplay(raw, backendHint = '') {
      return renderDisplayHtml(raw, backendHint);
    },
    onLeaveOpeningForChat: leaveOpeningForChat,
  },
});

// Expose ports for debug / future Mind bootstrap (not a public ST API).
if (typeof window !== 'undefined') {
  window.__conclavePorts = ports;
  window.__conclaveKernel = kernel;
}

window.addEventListener('error', event => {
  console.warn('[ConclaveSTHost] runtime error:', {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
});

window.addEventListener('unhandledrejection', event => {
  console.warn('[ConclaveSTHost] unhandled rejection:', event.reason);
});

void init();
