import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  regex_placement,
  parseFindRegex,
  expandReplacement,
  shouldRunScript,
  runRegexScript,
  getRegexedString,
  __resetSubstituteWarnCache,
} from './RegexEngine.js'
import { processDisplay } from './RenderPipeline.js'
import { stripHtmlFences } from './HtmlFence.js'

/** Display scripts must declare placement; empty array is skipped (ST). */
const AI = [regex_placement.AI_OUTPUT]

/**
 * @param {Partial<import('./RegexEngine.js').RegexScript> & { findRegex: string, replaceString: string }} partial
 */
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

beforeEach(() => {
  __resetSubstituteWarnCache()
})

describe('parseFindRegex', () => {
  it('parses /pattern/flags and forces g', () => {
    const p = parseFindRegex('/foo/mi')
    expect(p).toEqual({ source: 'foo', flags: 'mig' })
  })

  it('accepts bare patterns with forced g', () => {
    const p = parseFindRegex('hello')
    expect(p).toEqual({ source: 'hello', flags: 'g' })
  })

  it('returns null for empty', () => {
    expect(parseFindRegex('')).toBeNull()
    expect(parseFindRegex('   ')).toBeNull()
  })
})

describe('expandReplacement (Rust-compatible $n golden)', () => {
  it('expands $1 $2 capture groups (dialogue)', () => {
    const out = expandReplacement(
      '<div data-name="$1"><span>$1：</span><b>$2</b></div>',
      '【沈慕微】：“不是我。”',
      ['沈慕微', '“不是我。”'],
    )
    expect(out).toContain('data-name="沈慕微"')
    expect(out).toContain('<span>沈慕微：</span>')
    expect(out).toContain('<b>“不是我。”</b>')
    expect(out).not.toContain('$1')
    expect(out).not.toContain('$2')
  })

  it('$10 vs $1 two-digit when group 10 exists', () => {
    const groups = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    expect(expandReplacement('$1-$10', 'abcdefghij', groups)).toBe('a-j')
  })

  it('$10 falls back to $1 + "0" when only one group', () => {
    // two-digit index 10 > captureCount 1 → use $1 then literal next char is handled by parser:
    // Rust: if two_digit not valid, uses first_index alone → "$10" with 1 group → "a" + "0" = "a0"
    expect(expandReplacement('$10', 'a', ['a'])).toBe('a0')
  })

  it('keeps JS $fabaoGrid identifiers and $$ → $', () => {
    const out = expandReplacement("const $fabaoGrid = $('#cx-fabao-grid'); `${fb.id}` $$", 'm', [])
    expect(out).toContain("const $fabaoGrid = $('#cx-fabao-grid');")
    expect(out).toContain('`${fb.id}`')
    expect(out.endsWith(' $')).toBe(true)
  })

  it('expands $& full match and ${name} named groups', () => {
    expect(expandReplacement('[$&]', 'full', [])).toBe('[full]')
    expect(expandReplacement('${who}', 'x', [], { who: '沈慕微' })).toBe('沈慕微')
    expect(expandReplacement('${missing}', 'x', [], {})).toBe('${missing}')
  })
})

describe('shouldRunScript / placement', () => {
  it('empty placement array skips script (ST)', () => {
    const s = script({
      findRegex: 'a',
      replaceString: 'b',
      placement: [],
    })
    expect(
      shouldRunScript(s, {
        isMarkdown: false,
        isPrompt: false,
        placement: regex_placement.AI_OUTPUT,
      }),
    ).toBe(false)

    expect(getRegexedString('a', regex_placement.AI_OUTPUT, { isMarkdown: false }, [s])).toBe('a')
  })

  it('skips disabled and edit-without-runOnEdit', () => {
    expect(
      shouldRunScript(script({ findRegex: 'a', replaceString: 'b', disabled: true }), {
        placement: regex_placement.AI_OUTPUT,
      }),
    ).toBe(false)

    expect(
      shouldRunScript(script({ findRegex: 'a', replaceString: 'b', runOnEdit: false }), {
        isEdit: true,
        placement: regex_placement.AI_OUTPUT,
      }),
    ).toBe(false)
  })

  it('warns once for substituteRegex != 0', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = script({
      id: 'sub-1',
      findRegex: 'a',
      replaceString: 'b',
      substituteRegex: 1,
    })
    shouldRunScript(s, { placement: regex_placement.AI_OUTPUT })
    shouldRunScript(s, { placement: regex_placement.AI_OUTPUT })
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('getRegexedString stages (Rust golden + ST placement)', () => {
  it('expands dialogue capture groups via runRegexScript', () => {
    const s = script({
      scriptName: 'dialogue',
      findRegex: '/【(.*?)】\\s*[:：]\\s*([“\\"「].*?[”\\"」])/gm',
      replaceString: '<div data-name="$1"><span>$1：</span><b>$2</b></div>',
    })
    const output = getRegexedString(
      '【沈慕微】：“不是我。”',
      regex_placement.AI_OUTPUT,
      { isMarkdown: false },
      [s],
    )
    expect(output).toContain('data-name="沈慕微"')
    expect(output).toContain('<span>沈慕微：</span>')
    expect(output).toContain('<b>“不是我。”</b>')
    expect(output).not.toContain('$1')
  })

  it('two-digit $10 via processDisplay-equivalent stages', () => {
    const s = script({
      scriptName: 'ten groups',
      findRegex: '/(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)/g',
      replaceString: '$1-$10',
    })
    const output = getRegexedString('abcdefghij', regex_placement.AI_OUTPUT, { isMarkdown: false }, [
      s,
    ])
    expect(output).toBe('a-j')
  })

  it('keeps $fabaoGrid through replacement', () => {
    const s = script({
      findRegex: '/\\{\\{GameStart\\}\\}/g',
      replaceString: "const $fabaoGrid = $('#cx-fabao-grid'); `${fb.id}`",
    })
    const output = getRegexedString('{{GameStart}}', regex_placement.AI_OUTPUT, { isMarkdown: false }, [
      s,
    ])
    expect(output).toContain("const $fabaoGrid = $('#cx-fabao-grid');")
    expect(output).toContain('`${fb.id}`')
  })

  it('skips prompt_only on display source and markdown stages', () => {
    const promptCleanup = script({
      scriptName: 'prompt cleanup',
      findRegex: '<customized>\\s*(.*?)\\s*</customized>',
      replaceString: '开场',
      promptOnly: true,
      markdownOnly: false,
    })
    const displayUi = script({
      scriptName: 'display ui',
      findRegex: '<customized>\\s*(.*?)\\s*</customized>',
      replaceString: '```html <!doctype html><div class="panel">$1</div>```',
      markdownOnly: true,
      promptOnly: false,
    })

    // source stage: neither only → promptOnly skipped
    let out = getRegexedString(
      '<customized>角色开场</customized>',
      regex_placement.AI_OUTPUT,
      { isMarkdown: false, isPrompt: false },
      [promptCleanup, displayUi],
    )
    expect(out).toBe('<customized>角色开场</customized>')

    // markdown stage: markdownOnly runs
    out = getRegexedString(out, regex_placement.AI_OUTPUT, { isMarkdown: true, isPrompt: false }, [
      promptCleanup,
      displayUi,
    ])
    expect(out).toContain('<div class="panel">角色开场</div>')
    expect(out).not.toBe('开场')
  })

  it('markdownOnly+promptOnly true still runs on isMarkdown stage (hide UpdateVariable)', () => {
    const hideUpdate = script({
      scriptName: 'hide update',
      findRegex: '/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/gm',
      replaceString: '',
      markdownOnly: true,
      promptOnly: true,
    })

    const source = getRegexedString(
      "正文<UpdateVariable>_.set('x', 1, 2);</UpdateVariable>",
      regex_placement.AI_OUTPUT,
      { isMarkdown: false },
      [hideUpdate],
    )
    // source stage: both only flags → needs isMarkdown OR isPrompt; skipped on pure source
    expect(source).toContain('<UpdateVariable>')

    const md = getRegexedString(source, regex_placement.AI_OUTPUT, { isMarkdown: true }, [hideUpdate])
    expect(md).toBe('正文')
  })

  it('maps {{match}} to full match like ST', () => {
    const s = script({
      findRegex: '/foo/g',
      replaceString: '[{{match}}]',
    })
    expect(runRegexScript(s, 'foo bar foo')).toBe('[foo] bar [foo]')
  })
})

describe('HtmlFence stripHtmlFences', () => {
  it('strips inline and unlabeled html fences', () => {
    expect(stripHtmlFences('```html <!doctype html><div>ok</div>```')).toBe(
      '<!doctype html><div>ok</div>',
    )
    expect(stripHtmlFences('``` <!doctype html><span>ok</span>```')).toBe(
      '<!doctype html><span>ok</span>',
    )
  })

  it('prefers outer html fence over inner ``` in content', () => {
    const input = '```\n<!doctype html><script>const re = /```[\\s\\S]*?```/g;</script>\n```'
    const output = stripHtmlFences(input)
    expect(output.startsWith('<!doctype html>')).toBe(true)
    expect(output).toContain('const re = /```[\\s\\S]*?```/g;')
    expect(output.startsWith('```')).toBe(false)
    expect(output.endsWith('```')).toBe(false)
  })
})

describe('processDisplay e2e fence + dialogue', () => {
  it('beautify-style dialogue + fence strip', () => {
    const scripts = [
      script({
        scriptName: 'dialogue',
        findRegex: '/【(.*?)】\\s*[:：]\\s*([“\\"「].*?[”\\"」])/gm',
        replaceString: '<div data-name="$1"><span>$1：</span><b>$2</b></div>',
      }),
      script({
        scriptName: 'wrap',
        findRegex: 'x',
        replaceString: '```html <!doctype html><div>ok</div>```',
        markdownOnly: true,
      }),
    ]

    const dialogue = processDisplay('【沈慕微】：“不是我。”', [scripts[0]])
    expect(dialogue).toContain('data-name="沈慕微"')
    expect(dialogue).toContain('<b>“不是我。”</b>')

    const fenced = processDisplay('x', [scripts[1]])
    expect(fenced).toBe('<!doctype html><div>ok</div>')
  })
})
