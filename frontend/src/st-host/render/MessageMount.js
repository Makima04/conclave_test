/**
 * Minimal message DOM mount helper for PR-06.
 * PR-07 expands multi-message refresh and chat sync.
 *
 * @module st-host/render/MessageMount
 */

/**
 * @param {{
 *   getRoot: () => (HTMLElement|null|undefined),
 *   renderHtmlInto: (html: string, targetEl: HTMLElement) => void,
 * }} options
 */
export function createMessageMount({ getRoot, renderHtmlInto }) {
  /** @type {HTMLElement[]} */
  let mounted = []

  /**
   * Mount opening / primary assistant HTML into the message root.
   *
   * @param {string} html
   * @param {{ onMounted?: (node: HTMLElement) => void }} [opts]
   * @returns {HTMLElement|null}
   */
  function mountOpening(html, { onMounted } = {}) {
    const root = typeof getRoot === 'function' ? getRoot() : null
    if (!root) return null

    const node = document.createElement('section')
    node.className = 'st-assistant-message'
    root.appendChild(node)
    if (typeof renderHtmlInto === 'function') {
      renderHtmlInto(html ?? '', node)
    } else {
      node.innerHTML = html ?? ''
    }
    mounted.push(node)
    if (typeof onMounted === 'function') onMounted(node)
    return node
  }

  /**
   * Re-render HTML into an existing message node.
   *
   * @param {HTMLElement|null|undefined} node
   * @param {string} html
   */
  function refreshMessageNode(node, html) {
    if (!node) return
    if (typeof renderHtmlInto === 'function') {
      renderHtmlInto(html ?? '', node)
    } else {
      node.innerHTML = html ?? ''
    }
  }

  /**
   * Remove tracked mounts and clear the root.
   * Idempotent: safe to call repeatedly (card switch / double-teardown).
   */
  function clear() {
    for (const node of mounted) {
      try {
        node.remove()
      } catch {
        /* ignore */
      }
    }
    mounted = []
    const root = typeof getRoot === 'function' ? getRoot() : null
    if (root) {
      root.innerHTML = ''
    }
  }

  /**
   * Lifecycle alias for SessionKernel / card-switch teardown (PR-08).
   * Clears message DOM owned by this mount.
   */
  function teardown() {
    clear()
  }

  return {
    mountOpening,
    refreshMessageNode,
    clear,
    teardown,
  }
}
