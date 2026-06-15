import $ from 'jquery';
import _ from 'lodash';
import '@fortawesome/fontawesome-free/css/all.min.css';
import './index.css';
import './App.css';

const OPENING_SWIPE_REFRESH_DELAY_MS = 650;

const appState = {
  cardName: '',
  runtimeRequirements: null,
  worldbookEntries: [],
  tavernHelperScripts: [],
  importedWorldbooks: [],
  currentWorldbookId: null,
  activeView: 'opening',
  openingMessageNode: null,
  openingRawMessages: [''],
  openingRenderedMessages: [''],
  sending: false,
  importing: false,
  scriptRunId: 0,
  tavernHelperRunId: 0,
  runtime: null,
  pendingRefreshTimers: new Map(),
  cardArtifactObserver: null,
  cardArtifactNodes: new Set(),
};

const root = document.getElementById('root');
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

function scopedLocalStorageKeys(prefix) {
  const keys = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

function createScopedLocalStorage(namespace) {
  const prefix = `${namespace}localStorage:`;
  const storage = {
    get length() {
      return scopedLocalStorageKeys(prefix).length;
    },
    key(index) {
      return scopedLocalStorageKeys(prefix)[Number(index)]?.slice(prefix.length) ?? null;
    },
    getItem(key) {
      return window.localStorage.getItem(prefix + String(key));
    },
    setItem(key, value) {
      window.localStorage.setItem(prefix + String(key), String(value));
    },
    removeItem(key) {
      window.localStorage.removeItem(prefix + String(key));
    },
    clear() {
      scopedLocalStorageKeys(prefix).forEach(key => window.localStorage.removeItem(key));
    },
  };

  return new Proxy(storage, {
    get(target, property) {
      if (property in target) return target[property];
      if (typeof property === 'string') return target.getItem(property);
      return undefined;
    },
    set(target, property, value) {
      if (typeof property !== 'string') return false;
      target.setItem(property, value);
      return true;
    },
    deleteProperty(target, property) {
      if (typeof property !== 'string') return false;
      target.removeItem(property);
      return true;
    },
  });
}

function createScopedIndexedDB(namespace) {
  const prefix = `${namespace}indexedDB:`;
  return {
    open(name, version) {
      return window.indexedDB.open(prefix + String(name), version);
    },
    deleteDatabase(name) {
      return window.indexedDB.deleteDatabase(prefix + String(name));
    },
    cmp(first, second) {
      return window.indexedDB.cmp(first, second);
    },
    databases: window.indexedDB.databases
      ? () => window.indexedDB.databases()
      : undefined,
  };
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

function setRoot(html) {
  if (root) root.innerHTML = html;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderShell() {
  setRoot(`
    <div class="st-host">
      <header class="st-host-header">
        <div class="st-host-brand">
          <h1 id="st-card-name">${escapeHtml(appState.cardName || 'Conclave')}</h1>
          <span class="badge">Conclave ST Host</span>
        </div>
        <div class="st-host-actions">
          <button id="st-back-button" class="st-icon-button" type="button" title="返回开场">
            <i class="fa-solid fa-arrow-left"></i>
            <span>返回开场</span>
          </button>
          <label class="st-import-button" for="st-card-import" title="导入 JSON/PNG">
            <i class="fa-solid fa-file-import"></i>
            <span>导入 JSON/PNG</span>
            <input id="st-card-import" type="file" accept=".json,.png,application/json,image/png" />
          </label>
        </div>
      </header>
      <div class="st-workspace">
        <aside class="st-worldbook-sidebar">
          <div class="st-sidebar-heading">已导入世界书</div>
          <div id="st-worldbook-list" class="st-worldbook-list"></div>
        </aside>
        <section class="st-render-pane">
          <main id="st-message-area" class="st-message-area" aria-live="polite"></main>
          <form id="st-input-form" class="input-bar">
            <textarea id="st-user-input" placeholder="输入消息... (Enter 发送)" rows="1"></textarea>
            <button id="st-send-button" type="submit">发送</button>
          </form>
        </section>
      </div>
    </div>
  `);

  renderWorldbookSidebar();

  document.getElementById('st-back-button')?.addEventListener('click', () => showOpeningView());
  document.getElementById('st-card-import')?.addEventListener('change', event => {
    const file = event.currentTarget.files?.[0];
    if (file) void importCardFile(file);
    event.currentTarget.value = '';
  });
  document.getElementById('st-worldbook-list')?.addEventListener('click', event => {
    const button = event.target.closest('[data-worldbook-id]');
    if (!button) return;
    void selectImportedWorldbook(Number(button.dataset.worldbookId));
  });

  const form = document.getElementById('st-input-form');
  const input = document.getElementById('st-user-input');
  form?.addEventListener('submit', event => {
    event.preventDefault();
    void sendUserMessage();
  });
  input?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendUserMessage();
    }
  });
}

function showLoading() {
  setRoot('<div class="loading">正在加载角色卡...</div>');
}

function showError(message) {
  setRoot(`<div class="error">加载失败: ${escapeHtml(message)}</div>`);
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

function applyInitData(data) {
  clearPendingRefreshTimers();
  cleanupCardArtifacts();
  appState.tavernHelperRunId += 1;

  appState.cardName = data.card_name || 'Conclave';
  appState.runtimeRequirements = data.runtime_requirements || null;
  appState.worldbookEntries = Array.isArray(data.worldbook_entries) ? data.worldbook_entries : [];
  appState.tavernHelperScripts = Array.isArray(data.tavern_helper_scripts) ? data.tavern_helper_scripts : [];
  appState.importedWorldbooks = Array.isArray(data.imported_worldbooks) ? data.imported_worldbooks : [];
  appState.currentWorldbookId = Number.isFinite(Number(data.current_worldbook_id))
    ? Number(data.current_worldbook_id)
    : null;
  appState.openingRawMessages = [
    data.first_message || '',
    ...((Array.isArray(data.greetings) && data.greetings) || []),
  ];
  appState.openingRenderedMessages = [
    data.rendered_html || '',
    ...((Array.isArray(data.rendered_greetings) && data.rendered_greetings) || []),
  ];
  appState.activeView = 'opening';
  appState.openingMessageNode = null;
  appState.runtime = null;

  renderShell();
  beginCardArtifactTracking();
  showOpeningView();
  void executeTavernHelperScripts();
}

function renderWorldbookSidebar() {
  const list = document.getElementById('st-worldbook-list');
  if (!list) return;

  if (!appState.importedWorldbooks.length) {
    list.innerHTML = '<div class="st-worldbook-empty">尚未导入世界书</div>';
    return;
  }

  list.innerHTML = appState.importedWorldbooks.map(item => {
    const flags = [
      `${Number(item.entry_count || 0)} 条`,
      item.is_current ? '当前' : '可切换',
    ].filter(Boolean).join(' · ');

    return `
      <button class="st-worldbook-item${item.is_current ? ' is-active' : ''}" type="button" data-worldbook-id="${item.id}">
        <span class="st-worldbook-title">${escapeHtml(item.name || `导入项 ${item.id}`)}</span>
        <span class="st-worldbook-meta">${escapeHtml(flags)}</span>
      </button>
    `;
  }).join('');
}

function updateShellViewState() {
  document.querySelectorAll('[data-worldbook-id]').forEach(button => {
    const id = Number(button.dataset.worldbookId);
    button.classList.toggle('is-active', id === appState.currentWorldbookId);
  });
}

function showOpeningView() {
  const messageArea = document.getElementById('st-message-area');
  if (!messageArea) return;

  appState.activeView = 'opening';
  appState.openingMessageNode = null;
  messageArea.innerHTML = '';

  const runtime = ensureRuntime();
  const message = runtime.runtimeState.messages[0];
  const swipeId = Number.isFinite(Number(message?.swipe_id)) ? Number(message.swipe_id) : 0;
  const rendered = Array.isArray(message?.rendered_swipes) ? message.rendered_swipes[swipeId] : '';
  appendAssistantMessage(messageArea, rendered || message?.message || appState.openingRenderedMessages[0] || '', {
    opening: true,
  });
  renderOpeningSwipeControls();
  updateShellViewState();
}

function getOpeningSwipeState() {
  const runtime = ensureRuntime();
  const message = runtime.runtimeState.messages[0];
  const count = Math.max(
    Array.isArray(message?.swipes) ? message.swipes.length : 0,
    Array.isArray(message?.rendered_swipes) ? message.rendered_swipes.length : 0,
    appState.openingRawMessages.length,
    1
  );
  const current = Number.isFinite(Number(message?.swipe_id)) ? Number(message.swipe_id) : 0;
  return {
    count,
    current: Math.min(Math.max(current, 0), count - 1),
  };
}

function renderOpeningSwipeControls() {
  document.querySelectorAll('.st-opening-swipe-controls').forEach(node => node.remove());
  if (appState.activeView !== 'opening') return;

  const messageArea = document.getElementById('st-message-area');
  if (!messageArea) return;

  const { count, current } = getOpeningSwipeState();
  if (count <= 1) return;

  const controls = document.createElement('div');
  controls.className = 'st-opening-swipe-controls';
  controls.innerHTML = `
    <button type="button" data-swipe-delta="-1" aria-label="上一条开场" title="上一条开场">
      <i class="fa-solid fa-chevron-left"></i>
    </button>
    <span>${current + 1} / ${count}</span>
    <button type="button" data-swipe-delta="1" aria-label="下一条开场" title="下一条开场">
      <i class="fa-solid fa-chevron-right"></i>
    </button>
  `;
  controls.addEventListener('click', event => {
    const button = event.target instanceof Element
      ? event.target.closest('[data-swipe-delta]')
      : null;
    if (!button) return;
    void changeOpeningSwipe(Number(button.dataset.swipeDelta));
  });
  messageArea.appendChild(controls);
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
  if (importId === appState.currentWorldbookId) {
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
    applyInitData(data);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

function extractHtmlParts(htmlContent) {
  const parsed = new DOMParser().parseFromString(htmlContent || '', 'text/html');
  const scriptNodes = Array.from(parsed.querySelectorAll('script'));
  const scripts = scriptNodes.map(script => ({
    src: script.getAttribute('src') || '',
    type: script.getAttribute('type') || '',
    content: script.textContent || '',
  }));

  scriptNodes.forEach(script => script.remove());

  return {
    headNodes: Array.from(parsed.head.childNodes).map(node => node.cloneNode(true)),
    bodyHtml: parsed.body.innerHTML || htmlContent || '',
    scripts,
  };
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

function clone(value) {
  if (value === undefined) return undefined;
  try {
    return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value));
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
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
    applyInitData(data);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    appState.importing = false;
    setImportControlsDisabled(false);
  }
}

function setImportControlsDisabled(disabled) {
  const input = document.getElementById('st-card-import');
  const label = document.querySelector('.st-import-button');
  if (input) input.disabled = disabled;
  label?.classList.toggle('is-disabled', disabled);
}

async function readCardJsonFromFile(file) {
  const name = file.name.toLowerCase();
  if (file.type === 'image/png' || name.endsWith('.png')) {
    return extractCardJsonFromPng(await file.arrayBuffer());
  }
  return JSON.parse(await file.text());
}

function extractCardJsonFromPng(buffer) {
  const bytes = new Uint8Array(buffer);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) {
    throw new Error('PNG 文件签名无效');
  }

  const decoder = new TextDecoder();
  const chunks = [];
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = decoder.decode(bytes.slice(offset + 4, offset + 8));
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length) break;

    if (type === 'tEXt') {
      const chunk = bytes.slice(start, end);
      const split = chunk.indexOf(0);
      if (split >= 0) {
        chunks.push({
          keyword: decoder.decode(chunk.slice(0, split)),
          text: decoder.decode(chunk.slice(split + 1)),
        });
      }
    } else if (type === 'iTXt') {
      const parsed = parseInternationalTextChunk(bytes.slice(start, end), decoder);
      if (parsed) chunks.push(parsed);
    }

    offset = end + 4;
  }

  const preferred = chunks
    .filter(chunk => /^(chara|ccv3|character|card)$/i.test(chunk.keyword))
    .concat(chunks);

  for (const chunk of preferred) {
    const parsed = parsePossiblyEncodedJson(chunk.text);
    if (parsed) return parsed;
  }

  throw new Error('PNG 中未找到可解析的 SillyTavern 角色卡 JSON');
}

function parseInternationalTextChunk(chunk, decoder) {
  let offset = chunk.indexOf(0);
  if (offset < 0 || offset + 3 >= chunk.length) return null;

  const keyword = decoder.decode(chunk.slice(0, offset));
  const compressionFlag = chunk[offset + 1];
  if (compressionFlag !== 0) return null;
  offset += 3;

  const languageEnd = chunk.indexOf(0, offset);
  if (languageEnd < 0) return null;
  offset = languageEnd + 1;

  const translatedEnd = chunk.indexOf(0, offset);
  if (translatedEnd < 0) return null;

  return {
    keyword,
    text: decoder.decode(chunk.slice(translatedEnd + 1)),
  };
}

function parsePossiblyEncodedJson(value) {
  const candidates = [];
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;

  candidates.push(trimmed);

  try {
    candidates.push(decodeURIComponent(trimmed));
  } catch {
    // Not URI-encoded.
  }

  try {
    const base64 = trimmed.replace(/^data:[^,]+,/, '');
    candidates.push(decodeBase64Utf8(base64));
  } catch {
    // Not base64-encoded.
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next representation.
    }
  }

  return null;
}

function decodeBase64Utf8(value) {
  const binary = window.atob(value);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function readUint32(bytes, offset) {
  return (
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
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
    stat_data: {
      '主角状态': {
        '修为': {},
        '灵石钱包': {},
        '个人背包': {},
      },
      '世界系统': {
        '今日运势': {},
      },
      '人际交往': {
        '结识道友录': {},
      },
    },
  };
  const defaultProfileContent = '【苍玄界·{{user}}档案】\n\n【姓名】\n姓名：\n\n【性别】\n性别：无\n\n【初始境界】\n境界：无\n\n【随身信物】\n名称：无\n描述：无\n\n【同行道友】\n记录：\n无\n\n【过往经历】\n描述：无\n\n</rule>';
  const importedLorebookEntries = appState.worldbookEntries.map(entry => ({
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
  const defaultLorebookEntries = importedLorebookEntries.length ? importedLorebookEntries : [
    { uid: 1, id: 1, display_index: 1, comment: 'USER档案', enabled: true, content: defaultProfileContent },
    { uid: 2, id: 2, display_index: 2, comment: '小索【人设】', enabled: false, content: '' },
  ];
  const openingRawMessages = appState.openingRawMessages.length ? appState.openingRawMessages : [''];
  const openingRenderedMessages = appState.openingRenderedMessages.length ? appState.openingRenderedMessages : [''];
  const openingSwipeCount = Math.max(openingRawMessages.length, openingRenderedMessages.length, 1);
  const openingSwipes = Array.from({ length: openingSwipeCount }, (_, index) =>
    openingRawMessages[index] ?? openingRenderedMessages[index] ?? ''
  );
  const openingRenderedSwipes = Array.from({ length: openingSwipeCount }, (_, index) =>
    openingRenderedMessages[index] ?? ''
  );
  const openingSwipeData = Array.from({ length: openingSwipeCount }, (_, index) =>
    buildOpeningMvuData(openingSwipes[index], defaultMvuData)
  );
  const openingSwipeInfo = Array.from({ length: openingSwipeCount }, () => ({}));
  const initialMvuData = clone(openingSwipeData[0] || defaultMvuData);
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
      [appState.cardName || '当前角色卡世界书']: clone(defaultLorebookEntries),
      '苍玄界_修订版世界书': clone(defaultLorebookEntries),
      '我的苍玄界，才不会这么跌宕起伏！': clone(defaultLorebookEntries),
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
  const eventListeners = {};

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
          void eventEmit(Mvu.events.VARIABLE_UPDATE_ENDED, runtimeState.mvuData, oldData);
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
    if (!runtimeState.lorebooks[lorebook]) runtimeState.lorebooks[lorebook] = clone(defaultLorebookEntries);
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

  function eventOn(event, listener) {
    eventListeners[event] = eventListeners[event] || [];
    eventListeners[event].push(listener);
    return {
      stop() {
        eventRemoveListener(event, listener);
      },
    };
  }

  function eventOnce(event, listener) {
    const wrapped = (...args) => {
      eventRemoveListener(event, wrapped);
      return listener(...args);
    };
    return eventOn(event, wrapped);
  }

  function eventRemoveListener(event, listener) {
    eventListeners[event] = (eventListeners[event] || []).filter(item => item !== listener);
  }

  async function eventEmit(event, ...args) {
    console.debug('[ConclaveSTHost] runtime event:', { event, args });
    for (const listener of eventListeners[event] || []) await listener.apply(window, args);
    window.dispatchEvent(new CustomEvent('conclave:variables-updated', { detail: { event, args } }));
  }

  function initializeGlobal(globalName, value) {
    _.set(window, globalName, value);
    void eventEmit(`global_${globalName}_initialized`, value);
  }

  async function waitGlobalInitialized(globalName) {
    if (_.has(window, globalName)) return _.get(window, globalName);
    return new Promise(resolve => {
      eventOnce(`global_${globalName}_initialized`, value => resolve(value));
    });
  }

  function formatAsTavernRegexedString(text) {
    return String(text ?? '');
  }

  const Mvu = {
    events: {
      VARIABLE_INITIALIZED: 'mag_variable_initiailized',
      VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
      COMMAND_PARSED: 'mag_command_parsed',
      VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
      BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
    },
    getMvuData(options = { type: 'message', message_id: 'latest' }) {
      return getVariables(options);
    },
    async replaceMvuData(mvuData, options = { type: 'message', message_id: 'latest' }) {
      const oldData = clone(runtimeState.mvuData || {});
      replaceVariables(mvuData, options);
      runtimeState.mvuData = clone(mvuData);
      void eventEmit(Mvu.events.VARIABLE_UPDATE_ENDED, runtimeState.mvuData, oldData);
    },
    async parseMessage(_message, oldData) {
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
    eventEmit,
    eventRemoveListener,
  };

  Object.assign(window, {
    $,
    jQuery: $,
    _,
    lodash: _,
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
    eventEmit,
    eventRemoveListener,
    eventSource: {
      on: eventOn,
      once: eventOnce,
      emit: eventEmit,
      removeListener: eventRemoveListener,
    },
    Mvu,
    TavernHelper,
    SillyTavern: {
      getContext() {
        return TavernHelper;
      },
    },
  });

  return { runtimeState, triggerSlash, eventEmit };
}

function ensureRuntime() {
  if (!appState.runtime) appState.runtime = createRuntime();
  return appState.runtime;
}

async function executeTavernHelperScripts() {
  const runId = ++appState.tavernHelperRunId;
  const scripts = appState.tavernHelperScripts.filter(script => String(script.content || '').trim());
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

  if (runId === appState.tavernHelperRunId && appState.runtime) {
    const data = clone(appState.runtime.runtimeState.mvuData || {});
    await appState.runtime.eventEmit?.(window.Mvu?.events?.VARIABLE_UPDATE_ENDED || 'mag_variable_update_ended', data, data);
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

  const cardKey = `${appState.currentWorldbookId ?? 'current'}:${appState.cardName || 'default'}`;
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

function refreshDisplayedMessage(messageId) {
  if (messageId !== 0 || !appState.openingMessageNode || !appState.runtime) return;

  const message = appState.runtime.runtimeState.messages[0];
  if (!message) return;

  const swipeId = Number.isFinite(Number(message.swipe_id)) ? Number(message.swipe_id) : 0;
  const rendered = Array.isArray(message.rendered_swipes) ? message.rendered_swipes[swipeId] : '';
  renderCardHtml(rendered || message.message || '', appState.openingMessageNode);
  renderOpeningSwipeControls();
}

function appendUserMessage(messageArea, message) {
  const node = document.createElement('div');
  node.className = 'st-user-message';
  node.textContent = message;
  messageArea.appendChild(node);
}

function appendAssistantMessage(messageArea, htmlContent, options = {}) {
  const node = document.createElement('section');
  node.className = 'st-assistant-message';
  messageArea.appendChild(node);
  if (options.opening) appState.openingMessageNode = node;
  renderCardHtml(htmlContent, node);
  return node;
}

async function sendUserMessage() {
  const input = document.getElementById('st-user-input');
  const button = document.getElementById('st-send-button');
  const messageArea = document.getElementById('st-message-area');
  const message = input?.value.trim();
  if (!message || appState.sending || !messageArea) return;

  appState.sending = true;
  if (input) input.value = '';
  if (button) {
    button.disabled = true;
    button.textContent = '...';
  }
  appendUserMessage(messageArea, message);

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_message: message }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    appendAssistantMessage(messageArea, data.rendered_html || '');
  } catch (error) {
    const node = document.createElement('div');
    node.className = 'st-error-message';
    node.textContent = `发送失败: ${error instanceof Error ? error.message : String(error)}`;
    messageArea.appendChild(node);
  } finally {
    appState.sending = false;
    if (button) {
      button.disabled = false;
      button.textContent = '发送';
    }
  }
}

async function init() {
  showLoading();
  try {
    const response = await fetch('/api/init');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    applyInitData(data);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
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
