import { describe, it, expect, afterEach } from 'vitest'
import {
  makeDisplayHtml,
  shouldSkipMarkdown,
  resetMarkdownConverter,
  isDisplayMarkdownEnabled,
} from './MarkdownConverter.js'

afterEach(() => {
  resetMarkdownConverter()
})

describe('shouldSkipMarkdown', () => {
  it('skips empty and full HTML documents', () => {
    expect(shouldSkipMarkdown('')).toBe(true)
    expect(shouldSkipMarkdown('<!DOCTYPE html><html></html>')).toBe(true)
    expect(shouldSkipMarkdown('<html lang="zh">x</html>')).toBe(true)
  })

  it('does not skip plain prose', () => {
    expect(shouldSkipMarkdown('午时阳光\n洗剑池')).toBe(false)
  })
})

describe('makeDisplayHtml', () => {
  it('turns single newlines into br (simpleLineBreaks)', () => {
    const html = makeDisplayHtml('一行\n二行')
    expect(html).toMatch(/一行/)
    expect(html).toMatch(/二行/)
    expect(html.includes('<br') || /<br\s*\/?>/i.test(html)).toBe(true)
  })

  it('preserves injected HTML tags', () => {
    const html = makeDisplayHtml('<div class="bubble">冷小凝：你好</div>')
    expect(html).toContain('class="bubble"')
    expect(html).toContain('冷小凝')
  })

  it('respects enabled:false', () => {
    expect(makeDisplayHtml('a\nb', { enabled: false })).toBe('a\nb')
  })
})

describe('isDisplayMarkdownEnabled', () => {
  it('defaults ON', () => {
    const storage = {
      getItem: () => null,
    }
    expect(isDisplayMarkdownEnabled({ storage })).toBe(true)
    expect(
      isDisplayMarkdownEnabled({
        storage: { getItem: (k) => (k.includes('markdown') ? '0' : null) },
      }),
    ).toBe(false)
  })
})
