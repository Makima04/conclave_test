import { describe, it, expect } from 'vitest'
import {
  encodeStyleTags,
  decodeStyleTags,
  stripBreaksFromCss,
  prefixCssSelectors,
  withProtectedStyleTags,
} from './StyleTags.js'
import { makeDisplayHtml, resetMarkdownConverter } from './MarkdownConverter.js'
import { processDisplay } from './RenderPipeline.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('encodeStyleTags / decodeStyleTags', () => {
  it('round-trips style body via URI encoding', () => {
    const input = '<div>x</div><style>\n.foo { color: red; }\n</style><p>y</p>'
    const enc = encodeStyleTags(input)
    expect(enc).toContain('<custom-style>')
    expect(enc).not.toContain('<style>')
    expect(enc).toContain(encodeURIComponent('\n.foo { color: red; }\n'))

    const dec = decodeStyleTags(enc)
    expect(dec).toBe(input)
  })

  it('strips br tags injected into CSS on decode', () => {
    const css = '.a { color: red; }<br />.b { color: blue; }'
    const enc = `<custom-style>${encodeURIComponent(css)}</custom-style>`
    const dec = decodeStyleTags(enc)
    expect(dec).toBe('<style>.a { color: red; }.b { color: blue; }</style>')
    expect(dec).not.toMatch(/<br/i)
  })

  it('stripBreaksFromCss handles br variants', () => {
    expect(stripBreaksFromCss('a<br>b<br/>c<br />d')).toBe('abcd')
  })

  it('prefixCssSelectors scopes ordinary rules', () => {
    const css = '.status-card { color: red; }\nbody { margin: 0; }'
    const out = prefixCssSelectors(css, '.st-assistant-message ')
    expect(out).toContain('.st-assistant-message .status-card')
    expect(out).toContain('.st-assistant-message body')
  })

  it('withProtectedStyleTags keeps CSS through a br-injecting transform', () => {
    const input = '<style>\n.card { color: #fff; }\n</style><div class="card">ok</div>'
    const out = withProtectedStyleTags(input, (s) =>
      s.replace(/\n/g, '<br />\n'),
    )
    expect(out).toMatch(/<style>[\s\S]*\.card\s*\{/)
    expect(out).not.toMatch(/<style>[\s\S]*<br[\s\S]*<\/style>/i)
    expect(out).toContain('class="card"')
  })
})

describe('makeDisplayHtml style protect', () => {
  it('preserves multi-line style blocks under simpleLineBreaks', () => {
    resetMarkdownConverter()
    const input = [
      '叙事一行',
      '',
      '<style>',
      '.status-card {',
      '  color: red;',
      '  background: #fff;',
      '}',
      '</style>',
      '<div class="status-card">空庭调教日记</div>',
    ].join('\n')

    const html = makeDisplayHtml(input)
    const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    expect(styles.length).toBeGreaterThanOrEqual(1)
    expect(styles.some((m) => m[1].includes('.status-card'))).toBe(true)
    expect(styles.every((m) => !/<br/i.test(m[1]))).toBe(true)
    expect(html).toContain('空庭调教日记')
    expect(html).toContain('class="status-card"')
  })
})

describe('processDisplay bianshen status CSS (real card)', () => {
  it('keeps 状态栏美化 style intact after showdown', () => {
    const cardPath = join(
      __dirname,
      '../../../../fixtures/real-cards/bianshen-shaonu.json',
    )
    let card
    try {
      card = JSON.parse(readFileSync(cardPath, 'utf8'))
    } catch {
      // Fixture optional in some checkouts
      return
    }
    const scripts = card?.data?.extensions?.regex_scripts
    const raw = card?.data?.alternate_greetings?.[0]
    if (!Array.isArray(scripts) || !raw) return

    const out = processDisplay(raw, scripts, {
      userName: 'User',
      characterOverride: card.data.name || '',
    })

    const styles = [...out.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    expect(styles.length).toBeGreaterThanOrEqual(2)
    const statusStyle = styles.find((m) => m[1].includes('.status-card'))
    expect(statusStyle).toBeTruthy()
    expect(statusStyle[1]).not.toMatch(/<br/i)
    expect(out).toContain('空庭')
    expect(out).toMatch(/class=["']status-card["']/)
  })
})
