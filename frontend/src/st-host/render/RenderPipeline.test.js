import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  STATUS_PLACEHOLDER,
  messageHasStatusVariablePayload,
  appendStatusPlaceholderIfNeeded,
  processDisplay,
  isDisplayRegexFeEnabled,
} from './RenderPipeline.js'
import { regex_placement } from './RegexEngine.js'
import { createMessageMount } from './MessageMount.js'

const AI = [regex_placement.AI_OUTPUT]

function script(partial) {
  return {
    id: partial.id ?? '',
    scriptName: partial.scriptName ?? 'test',
    findRegex: partial.findRegex,
    replaceString: partial.replaceString,
    placement: partial.placement !== undefined ? partial.placement : AI,
    disabled: partial.disabled ?? false,
    markdownOnly: partial.markdownOnly ?? false,
    promptOnly: partial.promptOnly ?? false,
    runOnEdit: partial.runOnEdit ?? false,
    minDepth: partial.minDepth ?? null,
    maxDepth: partial.maxDepth ?? null,
    substituteRegex: partial.substituteRegex ?? 0,
  }
}

describe('messageHasStatusVariablePayload', () => {
  it('detects initvar and UpdateVariable case-insensitively', () => {
    expect(messageHasStatusVariablePayload('本卡游玩需要安装提示词模板，右滑开始。')).toBe(false)
    expect(
      messageHasStatusVariablePayload(
        "<UpdateVariable>_.set('<user>.称号', '旧', '新');</UpdateVariable>",
      ),
    ).toBe(true)
    expect(messageHasStatusVariablePayload('<initvar>\n主角状态:\n  修为: 无\n</initvar>')).toBe(
      true,
    )
    expect(messageHasStatusVariablePayload('<INITVAR>x</INITVAR>')).toBe(true)
    expect(messageHasStatusVariablePayload('<updatevariable></updatevariable>')).toBe(true)
  })
})

describe('appendStatusPlaceholderIfNeeded', () => {
  const statusbar = script({
    scriptName: 'statusbar',
    findRegex: STATUS_PLACEHOLDER,
    replaceString: '<div id="status-card">ok</div>',
    markdownOnly: true,
  })

  it('injects StatusPlaceHolder when initvar present + statusbar markdownOnly + no TH', () => {
    const msg = '<initvar>\nfoo: 1\n</initvar>\n正文'
    const out = appendStatusPlaceholderIfNeeded(msg, [statusbar], {
      hasTavernHelperScripts: false,
    })
    expect(out.endsWith(`\n${STATUS_PLACEHOLDER}`)).toBe(true)
    expect(out.startsWith(msg)).toBe(true)
  })

  it('injects when UpdateVariable payload present', () => {
    const msg = "<UpdateVariable>_.set('x', 1, 2);</UpdateVariable>"
    const out = appendStatusPlaceholderIfNeeded(msg, [statusbar])
    expect(out).toContain(STATUS_PLACEHOLDER)
  })

  it('does NOT inject when no variable payload', () => {
    const msg = '说明页，请右滑开始。'
    const out = appendStatusPlaceholderIfNeeded(msg, [statusbar], {
      hasTavernHelperScripts: false,
    })
    expect(out).toBe(msg)
    expect(out).not.toContain(STATUS_PLACEHOLDER)
  })

  it('does NOT inject when already present or TH scripts exist', () => {
    const withPh = `body\n${STATUS_PLACEHOLDER}`
    expect(appendStatusPlaceholderIfNeeded(withPh, [statusbar])).toBe(withPh)

    const msg = '<initvar>x</initvar>'
    expect(
      appendStatusPlaceholderIfNeeded(msg, [statusbar], { hasTavernHelperScripts: true }),
    ).toBe(msg)
  })

  it('does NOT inject when no matching statusbar regex', () => {
    const msg = '<initvar>x</initvar>'
    expect(appendStatusPlaceholderIfNeeded(msg, [])).toBe(msg)
    expect(
      appendStatusPlaceholderIfNeeded(msg, [
        script({
          findRegex: STATUS_PLACEHOLDER,
          replaceString: '<div/>',
          markdownOnly: false,
        }),
      ]),
    ).toBe(msg)
  })
})

describe('processDisplay StatusPlaceHolder integration', () => {
  it('replaces injected placeholder via markdownOnly statusbar script', () => {
    const statusbar = script({
      scriptName: 'statusbar',
      findRegex: STATUS_PLACEHOLDER,
      replaceString: '<div id="status-card">ok</div>',
      markdownOnly: true,
    })
    const opening = processDisplay(
      "<UpdateVariable>_.set('<user>.称号', '旧', '新');</UpdateVariable>",
      [statusbar],
    )
    expect(opening).toContain('status-card')
    expect(opening).not.toContain(STATUS_PLACEHOLDER)

    const intro = processDisplay('说明页，请右滑开始。', [statusbar])
    expect(intro).not.toContain('status-card')
  })

  it('end-to-end: prompt_only skipped, markdown fence stripped (Rust golden)', () => {
    const promptCleanup = script({
      scriptName: 'prompt cleanup',
      findRegex: '<customized>\\s*(.*?)\\s*</customized>',
      replaceString: '开场',
      promptOnly: true,
    })
    const displayUi = script({
      scriptName: 'display ui',
      findRegex: '<customized>\\s*(.*?)\\s*</customized>',
      replaceString: '```html <!doctype html><div class="panel">$1</div>```',
      markdownOnly: true,
    })

    const output = processDisplay('<customized>角色开场</customized>', [
      promptCleanup,
      displayUi,
    ])
    expect(output).toContain('<div class="panel">角色开场</div>')
    expect(output).not.toContain('```')
    expect(output).not.toBe('开场')
  })

  it('empty placement skips even if would match (ST)', () => {
    const s = script({
      findRegex: 'hello',
      replaceString: 'world',
      placement: [],
    })
    expect(processDisplay('hello', [s])).toBe('hello')
  })
})

describe('isDisplayRegexFeEnabled', () => {
  const store = new Map()

  beforeEach(() => {
    store.clear()
    vi.stubGlobal('localStorage', {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults ON and respects =0 off', () => {
    expect(isDisplayRegexFeEnabled()).toBe(true)
    globalThis.localStorage.setItem('conclave:feature:display_regex_fe', '0')
    expect(isDisplayRegexFeEnabled()).toBe(false)
    globalThis.localStorage.setItem('conclave:feature:display_regex_fe', '1')
    expect(isDisplayRegexFeEnabled()).toBe(true)
  })
})

describe('createMessageMount (smoke)', () => {
  it('exposes mountOpening / refreshMessageNode / clear', () => {
    const root = {
      children: [],
      appendChild(n) {
        this.children.push(n)
        n.parent = this
        n.remove = () => {
          this.children = this.children.filter((c) => c !== n)
        }
      },
      innerHTML: '',
    }
    // minimal DOM stubs for node env
    const created = []
    vi.stubGlobal('document', {
      createElement(tag) {
        const el = {
          tagName: tag.toUpperCase(),
          className: '',
          innerHTML: '',
          remove() {
            if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this)
          },
        }
        created.push(el)
        return el
      },
    })

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

    vi.unstubAllGlobals()
  })
})
