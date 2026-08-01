/**
 * Minimal document/DOM stubs for MessageMount in node vitest.
 */

/**
 * @returns {ParentNode & { children: object[], innerHTML: string }}
 */
export function createDomRoot() {
  const children = []
  const root = {
    children,
    appendChild(n) {
      children.push(n)
      n.parentNode = root
      n.isConnected = true
      n.remove = () => {
        const i = children.indexOf(n)
        if (i >= 0) children.splice(i, 1)
        n.isConnected = false
        n.parentNode = null
      }
    },
    insertBefore(n, ref) {
      const i = children.indexOf(ref)
      if (i >= 0) children.splice(i, 0, n)
      else children.push(n)
      n.parentNode = root
      n.isConnected = true
      n.remove = () => {
        const idx = children.indexOf(n)
        if (idx >= 0) children.splice(idx, 1)
        n.isConnected = false
        n.parentNode = null
      }
    },
    get innerHTML() {
      return children.map((c) => c.innerHTML || c.textContent || '').join('')
    },
    set innerHTML(v) {
      if (v === '') children.length = 0
    },
  }
  return root
}

/**
 * @param {import('vitest').VitestUtils} vi
 */
export function installDocumentStub(vi) {
  vi.stubGlobal('document', {
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        className: '',
        dataset: {},
        textContent: '',
        innerHTML: '',
        isConnected: false,
        parentNode: null,
        setAttribute(name, value) {
          if (name === 'data-message-id') {
            this.dataset = this.dataset || {}
            this.dataset.messageId = String(value)
          }
        },
        remove() {
          this.isConnected = false
        },
      }
    },
  })
}
