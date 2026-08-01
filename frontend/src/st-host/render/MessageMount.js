/**
 * MessageMount — sole DOM mount entry for chat bubbles (PR-07).
 *
 * Contract (architecture §3.4):
 *   bind(root), renderAll(), refresh(messageId), getNode(messageId), teardown()
 *
 * User + assistant share the same projector; opening swipe uses refresh(0).
 * TH setChatMessages / swipe → write Session → refresh(id); no innerHTML bypass of Session.
 *
 * @module st-host/render/MessageMount
 */

/**
 * @typedef {Object} MessageMountMessage
 * @property {number} message_id
 * @property {'user'|'assistant'|'system'} [role]
 * @property {string} [message]
 * @property {number} [swipe_id]
 * @property {string[]} [swipes]
 * @property {string[]} [rendered_swipes]
 */

/**
 * @param {{
 *   getRoot?: () => (HTMLElement|null|undefined),
 *   getMessages?: () => MessageMountMessage[],
 *   renderHtmlInto?: (html: string, targetEl: HTMLElement, msg?: MessageMountMessage) => void,
 * }} [options]
 */
export function createMessageMount(options = {}) {
  const { getRoot, getMessages, renderHtmlInto } = options

  /** @type {ParentNode|HTMLElement|null} */
  let boundRoot = null
  /** @type {Map<number, HTMLElement>} */
  const nodesById = new Map()

  /**
   * @returns {HTMLElement|ParentNode|null}
   */
  function resolveRoot() {
    if (boundRoot) return boundRoot
    return typeof getRoot === 'function' ? getRoot() || null : null
  }

  /**
   * @returns {MessageMountMessage[]}
   */
  function readMessages() {
    if (typeof getMessages !== 'function') return []
    const list = getMessages()
    return Array.isArray(list) ? list : []
  }

  /**
   * Bind (or re-bind) the mount root. Does not clear existing nodes.
   * @param {ParentNode|HTMLElement|null|undefined} root
   */
  function bind(root) {
    boundRoot = root || null
  }

  /**
   * @param {HTMLElement} node
   * @param {number|string} id
   */
  function setMessageIdAttr(node, id) {
    if (!node) return
    const value = String(id)
    // Prefer setAttribute — real HTMLElement.dataset is a read-only DOMStringMap.
    if (typeof node.setAttribute === 'function') {
      node.setAttribute('data-message-id', value)
    }
    // Test stubs may only expose a plain dataset object.
    if (node.dataset && typeof node.dataset === 'object') {
      node.dataset.messageId = value
    }
  }

  /**
   * @param {MessageMountMessage} msg
   * @returns {HTMLElement}
   */
  function createNodeForMessage(msg) {
    const role = msg?.role || 'assistant'
    if (role === 'user') {
      const node = document.createElement('div')
      node.className = 'st-user-message'
      setMessageIdAttr(node, msg.message_id)
      return node
    }
    if (role === 'system') {
      const node = document.createElement('div')
      node.className = 'st-system-message'
      setMessageIdAttr(node, msg.message_id)
      return node
    }
    const node = document.createElement('section')
    node.className = 'st-assistant-message'
    setMessageIdAttr(node, msg.message_id)
    return node
  }

  /**
   * @param {HTMLElement} node
   * @param {MessageMountMessage} msg
   */
  function fillNode(node, msg) {
    const role = msg?.role || 'assistant'
    if (role === 'user' || role === 'system') {
      node.textContent = msg.message || ''
      return
    }

    const swipeId = Number.isFinite(Number(msg.swipe_id)) ? Number(msg.swipe_id) : 0
    const raw =
      (Array.isArray(msg.swipes) ? msg.swipes[swipeId] : '') || msg.message || ''
    const hint =
      Array.isArray(msg.rendered_swipes) ? msg.rendered_swipes[swipeId] || '' : ''
    // Prefer pre-computed display HTML (FE RenderPipeline cache); fall back to raw.
    const html = hint || raw
    if (typeof renderHtmlInto === 'function') {
      renderHtmlInto(html, node, msg)
    } else {
      node.innerHTML = html
    }
  }

  /**
   * Refresh (or create) the DOM node for any messageId from Session messages.
   * @param {number} messageId
   * @returns {HTMLElement|null}
   */
  function refresh(messageId) {
    const root = resolveRoot()
    if (!root) return null

    const id = Number(messageId)
    if (!Number.isFinite(id) || id < 0) return null

    const messages = readMessages()
    const msg = messages[id]
    if (!msg) return null

    // Ensure message_id is set for data attributes.
    if (msg.message_id == null) msg.message_id = id

    let node = nodesById.get(id)
    const needsCreate = !node || (typeof node.isConnected === 'boolean' && !node.isConnected)
    if (needsCreate) {
      node = createNodeForMessage(msg)
      nodesById.set(id, node)
      // Append in id order when possible: insert before the next higher id node.
      let inserted = false
      for (let nextId = id + 1; nextId < messages.length; nextId += 1) {
        const nextNode = nodesById.get(nextId)
        if (nextNode && nextNode.parentNode === root) {
          root.insertBefore(node, nextNode)
          inserted = true
          break
        }
      }
      if (!inserted) {
        root.appendChild(node)
      }
    }

    fillNode(node, msg)
    return node
  }

  /**
   * Full re-project of Session.messages into the bound root.
   */
  function renderAll() {
    const root = resolveRoot()
    if (!root) return

    for (const node of nodesById.values()) {
      try {
        node.remove()
      } catch {
        /* ignore */
      }
    }
    nodesById.clear()
    if ('innerHTML' in root) {
      root.innerHTML = ''
    }

    const messages = readMessages()
    for (let i = 0; i < messages.length; i += 1) {
      refresh(i)
    }
  }

  /**
   * @param {number} messageId
   * @returns {HTMLElement|null}
   */
  function getNode(messageId) {
    const id = Number(messageId)
    return nodesById.get(id) || null
  }

  /**
   * Remove all tracked nodes and clear the root.
   */
  function teardown() {
    for (const node of nodesById.values()) {
      try {
        node.remove()
      } catch {
        /* ignore */
      }
    }
    nodesById.clear()
    const root = resolveRoot()
    if (root && 'innerHTML' in root) {
      root.innerHTML = ''
    }
    boundRoot = null
  }

  /**
   * @deprecated Prefer refresh(0) / renderAll. Kept for PR-06 smoke callers.
   * @param {string} html
   * @param {{ onMounted?: (node: HTMLElement) => void }} [opts]
   * @returns {HTMLElement|null}
   */
  function mountOpening(html, { onMounted } = {}) {
    const root = resolveRoot()
    if (!root) return null

    const node = document.createElement('section')
    node.className = 'st-assistant-message'
    setMessageIdAttr(node, 0)
    root.appendChild(node)
    if (typeof renderHtmlInto === 'function') {
      renderHtmlInto(html ?? '', node)
    } else {
      node.innerHTML = html ?? ''
    }
    nodesById.set(0, node)
    if (typeof onMounted === 'function') onMounted(node)
    return node
  }

  /**
   * @deprecated Prefer refresh(messageId).
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

  /** @deprecated Prefer teardown(). */
  function clear() {
    teardown()
  }

  return {
    bind,
    renderAll,
    refresh,
    getNode,
    teardown,
    // PR-06 compat
    mountOpening,
    refreshMessageNode,
    clear,
  }
}
