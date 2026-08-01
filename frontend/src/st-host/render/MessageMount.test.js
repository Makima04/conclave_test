/**
 * MessageMount contract tests (PR-07 §3.4).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMessageMount } from './MessageMount.js'

function createRoot() {
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
      }
    },
    get innerHTML() {
      return children.length ? 'has-children' : ''
    },
    set innerHTML(v) {
      if (v === '') children.length = 0
    },
  }
  return root
}

function installDocument() {
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
        remove() {
          this.isConnected = false
        },
      }
    },
  })
}

describe('createMessageMount contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('bind / renderAll / refresh / getNode / teardown for user + assistant', () => {
    installDocument()
    const root = createRoot()
    const messages = [
      {
        message_id: 0,
        role: 'assistant',
        message: 'open',
        swipe_id: 0,
        swipes: ['open'],
        rendered_swipes: ['<b>open</b>'],
      },
      {
        message_id: 1,
        role: 'user',
        message: 'hello',
      },
      {
        message_id: 2,
        role: 'assistant',
        message: 'hi',
        swipe_id: 0,
        swipes: ['hi'],
        rendered_swipes: ['<i>hi</i>'],
      },
    ]

    const mount = createMessageMount({
      getMessages: () => messages,
      renderHtmlInto: (html, el) => {
        el.innerHTML = html
      },
    })

    mount.bind(root)
    mount.renderAll()

    expect(root.children).toHaveLength(3)
    expect(mount.getNode(0).className).toBe('st-assistant-message')
    expect(mount.getNode(0).innerHTML).toBe('<b>open</b>')
    expect(mount.getNode(1).className).toBe('st-user-message')
    expect(mount.getNode(1).textContent).toBe('hello')
    expect(mount.getNode(2).innerHTML).toBe('<i>hi</i>')

    messages[1].message = 'hello world'
    mount.refresh(1)
    expect(mount.getNode(1).textContent).toBe('hello world')

    // opening swipe: change rendered_swipes[0] and refresh(0)
    messages[0].rendered_swipes[0] = '<b>swipe</b>'
    mount.refresh(0)
    expect(mount.getNode(0).innerHTML).toBe('<b>swipe</b>')

    mount.teardown()
    expect(root.children).toHaveLength(0)
    expect(mount.getNode(0)).toBeNull()
  })

  it('keeps PR-06 mountOpening / refreshMessageNode / clear aliases', () => {
    installDocument()
    const root = createRoot()
    const mount = createMessageMount({
      getRoot: () => root,
      renderHtmlInto: (html, el) => {
        el.innerHTML = html
      },
    })

    const node = mount.mountOpening('<b>hi</b>')
    expect(node.innerHTML).toBe('<b>hi</b>')
    expect(node.className).toBe('st-assistant-message')

    mount.refreshMessageNode(node, '<i>x</i>')
    expect(node.innerHTML).toBe('<i>x</i>')

    mount.clear()
    expect(root.innerHTML).toBe('')
  })
})
