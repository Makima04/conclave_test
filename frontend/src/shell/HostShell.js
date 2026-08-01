import { escapeHtml } from '../shared/escapeHtml.js';

/**
 * Host chrome: layout DOM, event wiring via callbacks, diagnostics mount point.
 * Business state (appState / runtime) stays in main.js.
 *
 * @param {object} options
 * @param {HTMLElement | null} options.root
 * @param {(file: File) => void} [options.onImportFile]
 * @param {(worldbookId: number) => void} [options.onSelectWorldbook]
 * @param {() => void} [options.onSend]
 * @param {() => void} [options.onReturnOpening]
 * @param {(delta: number) => void} [options.onSwipe]
 */
export function createHostShell({
  root,
  onImportFile,
  onSelectWorldbook,
  onSend,
  onReturnOpening,
  onSwipe,
} = {}) {
  function setRoot(html) {
    if (root) root.innerHTML = html;
  }

  function getMessageArea() {
    return document.getElementById('st-message-area');
  }

  function getUserInput() {
    return document.getElementById('st-user-input');
  }

  function getSendButton() {
    return document.getElementById('st-send-button');
  }

  function getDiagnosticsStrip() {
    return document.getElementById('st-diagnostics-strip');
  }

  function getMindDebug() {
    return document.getElementById('st-mind-debug');
  }

  function getWorldbookList() {
    return document.getElementById('st-worldbook-list');
  }

  /**
   * @param {{ cardName?: string, worldbooks?: Array<{ id: number, name?: string, entry_count?: number, is_current?: boolean }>, mindEnabled?: boolean }} [viewModel]
   */
  function renderShell(viewModel = {}) {
    const cardName = viewModel.cardName || 'Conclave';
    const worldbooks = Array.isArray(viewModel.worldbooks) ? viewModel.worldbooks : [];

    setRoot(`
    <div class="st-host">
      <header class="st-host-header">
        <div class="st-host-brand">
          <h1 id="st-card-name">${escapeHtml(cardName)}</h1>
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
      <div id="st-diagnostics-strip" class="st-diagnostics-strip" hidden aria-live="polite"></div>
      ${viewModel.mindEnabled ? '<div id="st-mind-debug" class="st-mind-debug" hidden aria-live="polite"></div>' : ''}
      <div class="st-workspace">
        <aside class="st-worldbook-sidebar">
          <div class="st-sidebar-heading">已导入世界书</div>
          <div id="st-worldbook-list" class="st-worldbook-list"></div>
        </aside>
        <section class="st-render-pane">
          <main id="st-message-area" class="st-message-area" aria-live="polite"></main>
          <div id="st-chat-status" class="st-chat-status" hidden role="status" aria-live="polite"></div>
          <form id="st-input-form" class="input-bar">
            <textarea id="st-user-input" placeholder="输入消息... (Enter 发送)" rows="1"></textarea>
            <button id="st-send-button" type="submit">发送</button>
          </form>
        </section>
      </div>
    </div>
  `);

    renderWorldbookSidebar(worldbooks);
    bindShellEvents();
  }

  function bindShellEvents() {
    document.getElementById('st-back-button')?.addEventListener('click', () => {
      onReturnOpening?.();
    });

    document.getElementById('st-card-import')?.addEventListener('change', event => {
      const file = event.currentTarget.files?.[0];
      if (file) onImportFile?.(file);
      event.currentTarget.value = '';
    });

    getWorldbookList()?.addEventListener('click', event => {
      const button = event.target.closest('[data-worldbook-id]');
      if (!button) return;
      onSelectWorldbook?.(Number(button.dataset.worldbookId));
    });

    const form = document.getElementById('st-input-form');
    const input = getUserInput();
    form?.addEventListener('submit', event => {
      event.preventDefault();
      onSend?.();
    });
    input?.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        onSend?.();
      }
    });
  }

  function showLoading() {
    setRoot('<div class="loading">正在加载角色卡...</div>');
  }

  function showError(message) {
    setRoot(`<div class="error">加载失败: ${escapeHtml(message)}</div>`);
  }

  /**
   * @param {Array<{ id: number, name?: string, entry_count?: number, is_current?: boolean }>} worldbooks
   */
  function renderWorldbookSidebar(worldbooks = []) {
    const list = getWorldbookList();
    if (!list) return;

    if (!worldbooks.length) {
      list.innerHTML = '<div class="st-worldbook-empty">尚未导入世界书</div>';
      return;
    }

    list.innerHTML = worldbooks.map(item => {
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

  /**
   * @param {number | null} currentWorldbookId
   */
  function updateWorldbookActive(currentWorldbookId) {
    document.querySelectorAll('[data-worldbook-id]').forEach(button => {
      const id = Number(button.dataset.worldbookId);
      button.classList.toggle('is-active', id === currentWorldbookId);
    });
  }

  function setImportControlsDisabled(disabled) {
    const input = document.getElementById('st-card-import');
    const label = document.querySelector('.st-import-button');
    if (input) input.disabled = disabled;
    label?.classList.toggle('is-disabled', disabled);
  }

  /**
   * Mount diagnostics text into #st-diagnostics-strip (empty / hidden when falsy).
   * @param {string | null | undefined} text
   */
  function setDiagnostics(text) {
    const strip = getDiagnosticsStrip();
    if (!strip) return;

    if (text == null || text === '') {
      strip.textContent = '';
      strip.hidden = true;
      return;
    }

    strip.hidden = false;
    strip.textContent = text;
  }

  function clearOpeningSwipeControls() {
    document.querySelectorAll('.st-opening-swipe-controls').forEach(node => node.remove());
  }

  /**
   * Pure DOM swipe controls; delta clicks go to onSwipe.
   * @param {{ count: number, current: number }} state
   */
  function renderOpeningSwipeControls({ count, current } = {}) {
    clearOpeningSwipeControls();
    const messageArea = getMessageArea();
    if (!messageArea) return;
    if (!Number.isFinite(count) || count <= 1) return;

    const safeCurrent = Number.isFinite(current) ? current : 0;
    const controls = document.createElement('div');
    controls.className = 'st-opening-swipe-controls';
    controls.innerHTML = `
    <button type="button" data-swipe-delta="-1" aria-label="上一条开场" title="上一条开场">
      <i class="fa-solid fa-chevron-left"></i>
    </button>
    <span>${safeCurrent + 1} / ${count}</span>
    <button type="button" data-swipe-delta="1" aria-label="下一条开场" title="下一条开场">
      <i class="fa-solid fa-chevron-right"></i>
    </button>
  `;
    controls.addEventListener('click', event => {
      const button = event.target instanceof Element
        ? event.target.closest('[data-swipe-delta]')
        : null;
      if (!button) return;
      onSwipe?.(Number(button.dataset.swipeDelta));
    });
    messageArea.appendChild(controls);
  }

  /**
   * @param {boolean} sending
   */
  function setSending(sending) {
    const button = getSendButton();
    if (!button) return;
    button.disabled = sending;
    button.textContent = sending ? '...' : '发送';
  }

  function clearUserInput() {
    const input = getUserInput();
    if (input) input.value = '';
  }

  /**
   * Ephemeral send/status banner **outside** #st-message-area so MessageMount
   * bubble counts stay equal to Session messages.length (PR-07 rule 4).
   * @param {string | null | undefined} text
   */
  function setChatStatus(text) {
    const el = document.getElementById('st-chat-status');
    if (!el) return;
    if (text == null || text === '') {
      el.textContent = '';
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.textContent = String(text);
  }

  function clearChatStatus() {
    setChatStatus('');
  }

  /**
   * Restore draft into the user input (e.g. after a failed send).
   * @param {string} text
   */
  function setUserInput(text) {
    const input = getUserInput();
    if (input) input.value = text == null ? '' : String(text);
  }

  return {
    renderShell,
    showLoading,
    showError,
    setDiagnostics,
    renderWorldbookSidebar,
    updateWorldbookActive,
    setImportControlsDisabled,
    clearOpeningSwipeControls,
    renderOpeningSwipeControls,
    setSending,
    clearUserInput,
    setUserInput,
    setChatStatus,
    clearChatStatus,
    getMessageArea,
    getUserInput,
    getSendButton,
    getDiagnosticsStrip,
    getMindDebug,
  };
}
