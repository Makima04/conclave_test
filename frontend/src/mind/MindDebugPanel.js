/**
 * Mind Debug Panel — mounts only when Mind is enabled.
 * Shows active count, last injection chars/preview, cleanup stats.
 *
 * Intentionally does not import shell — receives a host element.
 *
 * @module mind/MindDebugPanel
 */

/**
 * @param {{
 *   getSnapshot: () => import('./types.js').MindSnapshot | null | undefined,
 *   root?: HTMLElement | null,
 * }} options
 */
export function createMindDebugPanel({ getSnapshot, root = null }) {
  /** @type {HTMLElement | null} */
  let el = root && typeof root === 'object' ? root : null;
  let mounted = false;

  function ensureElement() {
    if (el && el.isConnected !== false) return el;
    if (typeof document === 'undefined') return null;
    let node = document.getElementById('st-mind-debug');
    if (!node) {
      node = document.createElement('div');
      node.id = 'st-mind-debug';
      node.className = 'st-mind-debug';
      node.setAttribute('aria-live', 'polite');
      const strip = document.getElementById('st-diagnostics-strip');
      if (strip && strip.parentNode) {
        strip.parentNode.insertBefore(node, strip.nextSibling);
      } else {
        const host = document.querySelector('.st-host') || document.body;
        host?.appendChild(node);
      }
    }
    el = node;
    return el;
  }

  function formatPreview(content, max = 160) {
    const s = String(content ?? '').replace(/\s+/g, ' ').trim();
    if (s.length <= max) return s;
    return `${s.slice(0, max)}…`;
  }

  function refresh() {
    const node = ensureElement();
    if (!node) return;
    mounted = true;
    const snap = typeof getSnapshot === 'function' ? getSnapshot() : null;
    if (!snap) {
      node.hidden = true;
      node.textContent = '';
      return;
    }
    node.hidden = false;
    const active = snap.cleanup?.activeCount ?? snap.memories?.length ?? 0;
    const cleanup = snap.cleanup || {};
    const inj = snap.lastInjection;
    const chars = inj?.chars ?? (inj?.content ? inj.content.length : 0);
    const preview = inj?.content ? formatPreview(inj.content) : '(none)';
    const removed =
      (Number(cleanup.removedDedupe) || 0) + (Number(cleanup.removedExpired) || 0);

    node.innerHTML = `
      <div class="st-mind-debug-row">
        <strong>Mind</strong>
        <span>active: ${active}</span>
        <span>cleanup removed: ${removed}</span>
        <span>last cleanup: ${cleanup.lastRunAt ? new Date(cleanup.lastRunAt).toISOString() : '—'}</span>
      </div>
      <div class="st-mind-debug-row">
        <span>last injection: ${chars} chars</span>
      </div>
      <pre class="st-mind-debug-preview">${escapeForPanel(preview)}</pre>
    `;
  }

  function unmount() {
    if (el) {
      el.hidden = true;
      el.textContent = '';
    }
    mounted = false;
  }

  return {
    refresh,
    unmount,
    isMounted: () => mounted,
    getElement: () => el,
  };
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeForPanel(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
