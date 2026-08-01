import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createScriptRunner,
  buildStorageNamespace,
  hasRemoteHttpImport,
  isRemoteScriptUrl,
  isRemoteThImportAllowed,
  isAllowlistedRemoteUrl,
  allRemoteImportsAllowlisted,
  isRemoteThImportAllowedForScript,
} from './ScriptRunner.js'

describe('buildStorageNamespace', () => {
  it('uses conclave:session:{sessionId}:card:{importId}: shape', () => {
    expect(buildStorageNamespace({ sessionId: 's1', importId: 3 })).toBe(
      'conclave:session:s1:card:3:',
    )
    expect(buildStorageNamespace({})).toBe('conclave:session:default:card:current:')
  })
})

describe('isRemoteScriptUrl', () => {
  it('matches http(s) and protocol-relative URLs', () => {
    expect(isRemoteScriptUrl('https://cdn.example/a.js')).toBe(true)
    expect(isRemoteScriptUrl('http://cdn.example/a.js')).toBe(true)
    expect(isRemoteScriptUrl('//cdn.example/a.js')).toBe(true)
    expect(isRemoteScriptUrl('./local.js')).toBe(false)
    expect(isRemoteScriptUrl('/absolute/path.js')).toBe(false)
  })
})

describe('hasRemoteHttpImport', () => {
  it('detects static and dynamic remote imports', () => {
    expect(hasRemoteHttpImport("import x from 'https://evil.example/m.js'")).toBe(true)
    expect(hasRemoteHttpImport("await import('http://evil.example/m.js')")).toBe(true)
    expect(hasRemoteHttpImport("import './local.js'")).toBe(false)
    expect(hasRemoteHttpImport('', ['https://cdn.example/a.js'])).toBe(true)
    expect(hasRemoteHttpImport('', ['./local.js'])).toBe(false)
  })

  it('detects multi-line named imports and export-from / protocol-relative', () => {
    const multiline = `import {\n  foo,\n  bar\n} from 'https://evil.example/m.js'`
    expect(hasRemoteHttpImport(multiline)).toBe(true)
    expect(
      hasRemoteHttpImport("export { x } from 'https://evil.example/m.js'"),
    ).toBe(true)
    expect(hasRemoteHttpImport("import x from '//cdn.example/m.js'")).toBe(true)
    expect(hasRemoteHttpImport("await import('//cdn.example/m.js')")).toBe(true)
    expect(hasRemoteHttpImport('', ['//cdn.example/a.js'])).toBe(true)
  })
})

describe('isRemoteThImportAllowed', () => {
  it('defaults allowlist-mode true; 0 denies; 1 full open', () => {
    const store = new Map()
    const storage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    }
    // Unset → allowlist mode enabled (boolean gate true).
    expect(isRemoteThImportAllowed(storage)).toBe(true)
    storage.setItem('conclave:feature:allow_remote_th_imports', '0')
    expect(isRemoteThImportAllowed(storage)).toBe(false)
    storage.setItem('conclave:feature:allow_remote_th_imports', '1')
    expect(isRemoteThImportAllowed(storage)).toBe(true)
  })
})

describe('remote allowlist', () => {
  it('allows jsdelivr / testingcf hosts used by cangxuan statusbar', () => {
    expect(
      isAllowlistedRemoteUrl(
        'https://testingcf.jsdelivr.net/gh/suosuosaku/st@cangxuan-v1.0.19/dist/cangxuan/statusbar/index.js',
      ),
    ).toBe(true)
    expect(isAllowlistedRemoteUrl('https://evil.example/malware.js')).toBe(false)
    expect(
      allRemoteImportsAllowlisted(
        "import 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js';",
      ),
    ).toBe(true)
    expect(allRemoteImportsAllowlisted("import 'https://evil.example/x.js';")).toBe(
      false,
    )
    expect(
      isRemoteThImportAllowedForScript({
        content:
          "import 'https://testingcf.jsdelivr.net/gh/suosuosaku/st@cangxuan-v1.0.19/dist/cangxuan/statusbar/index.js'",
      }),
    ).toBe(true)
  })
})

/**
 * Minimal document stub for node vitest (no happy-dom).
 */
function createMockDocument() {
  const bodyChildren = []
  const headChildren = []
  const htmlChildren = []

  function createEl(tag) {
    const attrs = new Map()
    const el = {
      nodeType: 1, // ELEMENT_NODE
      tagName: String(tag).toUpperCase(),
      className: '',
      id: '',
      textContent: '',
      src: '',
      type: '',
      dataset: {},
      isConnected: true,
      parent: null,
      children: [],
      childNodes: [],
      setAttribute(name, value) {
        attrs.set(name, String(value))
        if (name === 'id') this.id = String(value)
        if (name.startsWith('data-')) {
          const key = name
            .slice(5)
            .replace(/-([a-z])/g, (_, c) => c.toUpperCase())
          this.dataset[key] = String(value)
        }
      },
      getAttribute(name) {
        if (name === 'id') return this.id || null
        return attrs.has(name) ? attrs.get(name) : null
      },
      removeAttribute(name) {
        attrs.delete(name)
        if (name === 'id') this.id = ''
      },
      contains(other) {
        if (!other || other === this) return other === this
        let n = other
        while (n) {
          if (n === this) return true
          n = n.parent
        }
        return false
      },
      remove() {
        this.isConnected = false
        if (this.parent?.children) {
          this.parent.children = this.parent.children.filter((c) => c !== this)
        }
        if (this.parent?.childNodes) {
          this.parent.childNodes = this.parent.childNodes.filter((c) => c !== this)
        }
        const bi = bodyChildren.indexOf(this)
        if (bi >= 0) bodyChildren.splice(bi, 1)
        const hi = headChildren.indexOf(this)
        if (hi >= 0) headChildren.splice(hi, 1)
        const yi = htmlChildren.indexOf(this)
        if (yi >= 0) htmlChildren.splice(yi, 1)
      },
      appendChild(child) {
        child.parent = this
        this.children.push(child)
        this.childNodes.push(child)
        return child
      },
    }
    return el
  }

  const documentElement = createEl('html')
  const body = createEl('body')
  const head = createEl('head')
  // Structural children of <html>
  documentElement.appendChild(head)
  documentElement.appendChild(body)
  // Baseline includes head/body; card injects are extra html children.
  documentElement.childNodes = [head, body]
  documentElement.children = [head, body]
  head.childNodes = []
  body.childNodes = []

  body.appendChild = function appendChild(child) {
    child.parent = body
    body.children.push(child)
    body.childNodes.push(child)
    bodyChildren.push(child)
    return child
  }
  head.appendChild = function appendChild(child) {
    child.parent = head
    head.children.push(child)
    head.childNodes.push(child)
    headChildren.push(child)
    return child
  }
  documentElement.appendChild = function appendChild(child) {
    child.parent = documentElement
    documentElement.children.push(child)
    documentElement.childNodes.push(child)
    htmlChildren.push(child)
    return child
  }

  return {
    documentElement,
    body,
    head,
    createElement: createEl,
    querySelectorAll(sel) {
      const all = [...bodyChildren, ...headChildren, ...htmlChildren]
      if (sel.includes('st-social-phone')) {
        return all.filter((n) => n.id === 'st-social-phone')
      }
      if (sel.includes('data-conclave-card-script')) {
        return all.filter(
          (n) =>
            n.dataset?.conclaveCardScript != null ||
            n.getAttribute?.('data-conclave-card-script') != null,
        )
      }
      if (sel.includes('data-conclave-card-head')) {
        return all.filter((n) => n.getAttribute?.('data-conclave-card-head') === 'true')
      }
      return []
    },
    _bodyChildren: bodyChildren,
    _htmlChildren: htmlChildren,
  }
}

describe('createScriptRunner', () => {
  let warn

  beforeEach(() => {
    warn = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('aborts multi-run TH work so only the latest generation completes', async () => {
    let resolveFirst
    const firstGate = new Promise((resolve) => {
      resolveFirst = resolve
    })
    let urlSeq = 0
    const createObjectURL = vi.fn(() => {
      urlSeq += 1
      return `blob:test-${urlSeq}`
    })
    const importModule = vi.fn(async (url) => {
      // First import (run A / slow) blocks until a second run aborts it.
      if (url === 'blob:test-1') {
        await firstGate
      }
    })

    const runner = createScriptRunner({
      importModule,
      createObjectURL,
      revokeObjectURL: vi.fn(),
      warn,
      allowRemoteImports: false,
    })

    const onCompleteA = vi.fn()
    const onCompleteB = vi.fn()

    const runA = runner.runTavernHelper(
      [
        { name: 'slow', content: 'export const a = 1' },
        { name: 'after-slow', content: 'export const b = 2' },
      ],
      { onComplete: onCompleteA },
    )

    // Mid-flight abort via a second run (card switch simulation).
    await Promise.resolve()
    const runB = runner.runTavernHelper(
      [{ name: 'fast', content: 'export const c = 3' }],
      { onComplete: onCompleteB },
    )

    resolveFirst()
    await Promise.all([runA, runB])

    // slow started (blob:1); after-slow must not create a blob; fast is blob:2.
    expect(createObjectURL).toHaveBeenCalledTimes(2)
    expect(importModule).toHaveBeenCalledTimes(2)
    expect(importModule.mock.calls.map((c) => c[0])).toEqual([
      'blob:test-1',
      'blob:test-2',
    ])
    expect(onCompleteA).not.toHaveBeenCalled()
    expect(onCompleteB).toHaveBeenCalledTimes(1)
    expect(runner.getTavernHelperRunId()).toBeGreaterThanOrEqual(2)
  })

  it('abort() cancels pending TH and bumps run ids', async () => {
    let release
    const gate = new Promise((r) => {
      release = r
    })
    const importModule = vi.fn(async () => {
      await gate
    })
    const runner = createScriptRunner({
      importModule,
      createObjectURL: () => 'blob:pending',
      revokeObjectURL: vi.fn(),
      warn,
    })

    const pending = runner.runTavernHelper([
      { name: 'one', content: 'export default 1' },
      { name: 'two', content: 'export default 2' },
    ])
    const idBefore = runner.getTavernHelperRunId()
    runner.abort()
    expect(runner.getTavernHelperRunId()).toBeGreaterThan(idBefore)
    expect(runner.getSignal()).toBeNull()
    release()
    await pending
    // Only first import may have been scheduled before abort.
    expect(importModule.mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('teardown removes tracked nodes and is safe to call twice', () => {
    const doc = createMockDocument()
    const runner = createScriptRunner({
      document: doc,
      hostBaseline: {
        htmlClassName: 'host',
        htmlStyle: null,
        bodyClassName: 'body-host',
        bodyStyle: null,
      },
      warn,
    })

    const stray = doc.createElement('div')
    stray.className = 'card-ui'
    doc.body.appendChild(stray)
    runner.rememberCardArtifact(stray)

    runner.runInlineHtmlScripts([{ content: 'window.__x = 1', type: 'text/javascript' }])
    expect(doc._bodyChildren.length).toBeGreaterThanOrEqual(1)

    runner.teardown()
    expect(stray.isConnected).toBe(false)
    expect(runner.isTornDown()).toBe(true)

    expect(() => runner.teardown()).not.toThrow()
    expect(() => runner.abort()).not.toThrow()
    expect(() => runner.cleanupArtifacts()).not.toThrow()
  })

  it('cleanup removes documentElement sticky phone even if never tracked', () => {
    // 静浦小手机: (documentElement||body).appendChild(root) with id st-social-phone
    const doc = createMockDocument()
    const hostRoot = doc.createElement('div')
    hostRoot.id = 'st-message-area'
    doc.body.appendChild(hostRoot)

    const runner = createScriptRunner({
      document: doc,
      getHostRoot: () => hostRoot,
      hostBaseline: {
        htmlClassName: '',
        htmlStyle: null,
        bodyClassName: '',
        bodyStyle: null,
      },
      warn,
    })

    // Baseline = head/body (+ hostRoot already on body). Capture before phone.
    runner.beginCardArtifactTracking()

    const phone = doc.createElement('div')
    phone.id = 'st-social-phone'
    phone.setAttribute('id', 'st-social-phone')
    doc.documentElement.appendChild(phone)
    // Intentionally do NOT call rememberCardArtifact — observer would in browser.

    runner.cleanupArtifacts()
    expect(phone.isConnected).toBe(false)
    expect(doc._htmlChildren.includes(phone)).toBe(false)
    // Host chat root must survive.
    expect(hostRoot.isConnected).toBe(true)
  })

  it('cleanup does not remove host root children when sweeping body extras', () => {
    const doc = createMockDocument()
    const hostRoot = doc.createElement('div')
    hostRoot.id = 'host'
    doc.body.appendChild(hostRoot)
    const bubble = doc.createElement('section')
    bubble.className = 'st-assistant-message'
    hostRoot.appendChild(bubble)

    const runner = createScriptRunner({
      document: doc,
      getHostRoot: () => hostRoot,
      warn,
    })
    runner.beginCardArtifactTracking()
    runner.cleanupArtifacts()
    expect(hostRoot.isConnected).toBe(true)
    expect(bubble.parent).toBe(hostRoot)
  })

  it('skips remote http imports by default', async () => {
    const importModule = vi.fn(async () => ({}))
    const runner = createScriptRunner({
      importModule,
      createObjectURL: () => 'blob:remote',
      revokeObjectURL: vi.fn(),
      allowRemoteImports: false,
      warn,
    })

    await runner.runTavernHelper([
      {
        name: 'remote-mod',
        content: "import 'https://cdn.example.com/evil.js'\nexport default 1",
        imports: ['https://cdn.example.com/evil.js'],
      },
    ])

    expect(importModule).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('skips multi-line remote from and remote script src by default', async () => {
    const importModule = vi.fn(async () => ({}))
    const doc = createMockDocument()
    const runner = createScriptRunner({
      document: doc,
      importModule,
      createObjectURL: () => 'blob:ml',
      revokeObjectURL: vi.fn(),
      allowRemoteImports: false,
      warn,
    })

    await runner.runTavernHelper([
      {
        name: 'ml',
        content: "import {\n  x\n} from 'https://cdn.example.com/evil.js'\nexport default 1",
      },
    ])
    expect(importModule).not.toHaveBeenCalled()

    const before = doc._bodyChildren.length
    runner.runInlineHtmlScripts([{ src: 'https://cdn.example.com/widget.js' }])
    expect(doc._bodyChildren.length).toBe(before)
    expect(warn).toHaveBeenCalled()
  })

  it('empty TH list invalidates prior run without leaving a live signal', async () => {
    let release
    const gate = new Promise((r) => {
      release = r
    })
    const importModule = vi.fn(async () => {
      await gate
    })
    const runner = createScriptRunner({
      importModule,
      createObjectURL: () => 'blob:empty',
      revokeObjectURL: vi.fn(),
      warn,
    })
    const pending = runner.runTavernHelper([{ content: 'export default 1' }])
    expect(runner.getSignal()).not.toBeNull()
    await runner.runTavernHelper([])
    expect(runner.getSignal()).toBeNull()
    release()
    await pending
  })

  it('executes remote imports when allowRemoteImports is true', async () => {
    const importModule = vi.fn(async () => ({}))
    const runner = createScriptRunner({
      importModule,
      createObjectURL: () => 'blob:ok',
      revokeObjectURL: vi.fn(),
      allowRemoteImports: true,
      warn,
    })

    await runner.runTavernHelper([
      {
        name: 'remote-ok',
        content: "import 'https://cdn.example.com/ok.js'\nexport default 1",
      },
    ])

    expect(importModule).toHaveBeenCalledTimes(1)
  })

  it('onComplete only fires for active generation', async () => {
    const importModule = vi.fn(async () => ({}))
    const onComplete = vi.fn()
    const runner = createScriptRunner({
      importModule,
      createObjectURL: () => 'blob:c',
      revokeObjectURL: vi.fn(),
      warn,
    })

    await runner.runTavernHelper([{ content: 'export default 1' }], {
      onComplete,
      getRuntime: () => ({ ok: true }),
    })
    expect(onComplete).toHaveBeenCalledTimes(1)

    onComplete.mockClear()
    let release
    const gate = new Promise((r) => {
      release = r
    })
    const slowImport = vi.fn(async () => {
      await gate
    })
    const runner2 = createScriptRunner({
      importModule: slowImport,
      createObjectURL: () => 'blob:slow',
      revokeObjectURL: vi.fn(),
      warn,
    })
    const p = runner2.runTavernHelper([{ content: 'export default 1' }], {
      onComplete,
    })
    runner2.abort()
    release()
    await p
    expect(onComplete).not.toHaveBeenCalled()
  })
})
