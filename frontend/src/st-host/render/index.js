/**
 * Display RenderPipeline public surface (PR-06).
 *
 * @module st-host/render
 */

export { stripHtmlFences, stripOuterHtmlFence, looksLikeHtml } from './HtmlFence.js'

export {
  makeDisplayHtml,
  isDisplayMarkdownEnabled,
  shouldSkipMarkdown,
  getMarkdownConverter,
  resetMarkdownConverter,
} from './MarkdownConverter.js'

export {
  encodeStyleTags,
  decodeStyleTags,
  stripBreaksFromCss,
  prefixCssSelectors,
  withProtectedStyleTags,
} from './StyleTags.js'

export {
  regex_placement,
  parseFindRegex,
  expandReplacement,
  shouldRunScript,
  runRegexScript,
  getRegexedString,
  substituteBasicParams,
} from './RegexEngine.js'

export {
  STATUS_PLACEHOLDER,
  messageHasStatusVariablePayload,
  appendStatusPlaceholderIfNeeded,
  processDisplay,
  isDisplayRegexFeEnabled,
} from './RenderPipeline.js'

export { createMessageMount } from './MessageMount.js'
