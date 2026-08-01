/**
 * ST-aligned style-tag protect / restore around showdown.
 *
 * Source of truth: SillyTavern `encodeStyleTags` / `decodeStyleTags`
 * (public/scripts/chats.js), originally from RisuAI.
 *
 * Why Conclave encodes *before* makeHtml (ST encodes after for DOMPurify):
 * showdown + simpleLineBreaks can break large card `<style>` blocks
 * (e.g. 变身少女「状态栏美化」with data-URI backgrounds) — the closing
 * `</style>` is lost and CSS becomes narrative with `<br />`. Encoding
 * first keeps CSS out of the markdown pass; decode restores it and
 * strips any residual `<br>` inside style content.
 *
 * Full ST decode also rewrites selectors via @adobe/css-tools + DOMPurify
 * class renames (`.foo` → `.custom-foo`, scoped under `.mes_text`). We
 * keep a lighter restore path first: URI-decode + br strip + optional
 * selector prefix without class renaming (HTML classes stay as authored).
 *
 * @module st-host/render/StyleTags
 */

/**
 * Wrap each `<style>...</style>` body as URI-encoded `<custom-style>`.
 * Matches ST: only bare `<style>` (no attributes).
 *
 * @param {string} text
 * @returns {string}
 */
export function encodeStyleTags(text) {
  if (text == null) return ''
  const raw = String(text)
  if (!raw) return ''
  // Same regex family as ST: /<style>(.+?)<\/style>/gims
  return raw.replace(/<style>([\s\S]*?)<\/style>/gim, (_, match) => {
    return `<custom-style>${encodeURIComponent(match)}</custom-style>`
  })
}

/**
 * Strip showdown-injected breaks from decoded CSS text.
 * ST: `.replaceAll(/<br\/>/g, '')` — we also accept `<br>`, `<br />`.
 *
 * @param {string} css
 * @returns {string}
 */
export function stripBreaksFromCss(css) {
  return String(css ?? '').replace(/<br\s*\/?>/gi, '')
}

/**
 * Optionally prefix top-level selectors so card CSS stays under a message root.
 * Does **not** rename classes to `custom-*` (that needs matching HTML rewrites).
 *
 * Heuristic line-based prefixer (no full CSS AST). Skips @-rules, comments,
 * and bare `from`/`to` keyframe stops. Good enough for card statusbars.
 *
 * @param {string} css
 * @param {string} prefix e.g. `.st-assistant-message `
 * @returns {string}
 */
export function prefixCssSelectors(css, prefix) {
  const p = String(prefix ?? '')
  if (!p) return String(css ?? '')

  const input = String(css ?? '')
  // Prefix selectors of ordinary rules: "selector { ... }"
  // Avoid @media / @keyframes / @import / @font-face headers.
  return input.replace(
    /(^|})(\s*)([^@}{][^{]*?)(\s*\{)/g,
    (full, brace, ws, selector, open) => {
      const sel = selector.trim()
      if (!sel) return full
      // keyframes steps
      if (/^(from|to|\d+%)$/i.test(sel)) return full
      // already scoped
      if (sel.startsWith(p.trim()) || sel.includes(p.trim())) {
        return `${brace}${ws}${selector}${open}`
      }
      const parts = sel.split(',').map((part) => {
        const s = part.trim()
        if (!s) return s
        if (s.startsWith(p.trim())) return s
        return `${p}${s}`
      })
      return `${brace}${ws}${parts.join(', ')}${open}`
    },
  )
}

/**
 * Restore encoded custom-style tags to real `<style>` blocks.
 *
 * @param {string} text
 * @param {{
 *   prefix?: string,
 *   mediaAllowed?: boolean,
 * }} [options]
 *   - prefix: if set, prefix ordinary selectors (default none — keep card CSS as authored)
 *   - mediaAllowed: when false, drop url(...) with :// (ST external-media gate). Default true.
 * @returns {string}
 */
export function decodeStyleTags(text, options = {}) {
  if (text == null) return ''
  const raw = String(text)
  if (!raw) return ''

  const prefix = options.prefix != null ? String(options.prefix) : ''
  const mediaAllowed = options.mediaAllowed !== false

  // ST: /<custom-style>(.+?)<\/custom-style>/gms
  return raw.replace(/<custom-style>([\s\S]*?)<\/custom-style>/gm, (_, style) => {
    try {
      let cleaned = stripBreaksFromCss(decodeURIComponent(style))
      if (!mediaAllowed) {
        // Drop declarations whose value embeds a remote URL (ST filters ://).
        cleaned = cleaned.replace(
          /[^{};]+:[^;{}]*:\/\/[^;{}]*;?/gi,
          '',
        )
      }
      if (prefix) {
        cleaned = prefixCssSelectors(cleaned, prefix)
      }
      return `<style>${cleaned}</style>`
    } catch (error) {
      return `CSS ERROR: ${error}`
    }
  })
}

/**
 * Protect → transform → restore helper used around makeHtml.
 *
 * @param {string} text
 * @param {(s: string) => string} transform
 * @param {{ prefix?: string, mediaAllowed?: boolean }} [decodeOptions]
 * @returns {string}
 */
export function withProtectedStyleTags(text, transform, decodeOptions = {}) {
  const encoded = encodeStyleTags(text)
  const next = typeof transform === 'function' ? transform(encoded) : encoded
  return decodeStyleTags(next, decodeOptions)
}
