/**
 * Shared pure helpers for chat transcript entries / MVU apply.
 * Used by bridge Ports (production write path) and SessionStore (test/TH mirrors)
 * so field shapes cannot drift.
 *
 * @module shared/chatTranscript
 */

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Build a Session/TH-shaped chat message entry for append.
 *
 * @param {number} messageId  Next index (= current list length)
 * @param {Partial<{
 *   role: string,
 *   name: string,
 *   is_hidden: boolean,
 *   message: string,
 *   data: object,
 *   extra: object,
 *   swipe_id: number,
 *   swipes: string[],
 *   rendered_swipes: string[],
 *   swipes_data: object[],
 *   swipes_info: object[],
 * }>} [msg]
 * @returns {object}
 */
export function buildChatMessageEntry(messageId, msg = {}) {
  const isUser = msg.role === 'user'
  const text = msg.message ?? ''
  const data = isPlainObject(msg.data) ? msg.data : {}
  return {
    message_id: messageId,
    role: msg.role || 'assistant',
    name: msg.name || (isUser ? 'User' : 'assistant'),
    is_hidden: !!msg.is_hidden,
    message: String(text),
    data,
    extra: isPlainObject(msg.extra) ? msg.extra : {},
    swipe_id: Number.isFinite(Number(msg.swipe_id)) ? Number(msg.swipe_id) : 0,
    swipes: Array.isArray(msg.swipes) ? msg.swipes : [String(text)],
    rendered_swipes: Array.isArray(msg.rendered_swipes) ? msg.rendered_swipes : [''],
    swipes_data: Array.isArray(msg.swipes_data) ? msg.swipes_data : [data],
    swipes_info: Array.isArray(msg.swipes_info) ? msg.swipes_info : [{}],
  }
}

/**
 * Apply MVU onto runtimeState: mvuData + latest assistant data/swipes_data.
 * Mutates `state` in place.
 *
 * @param {{ mvuData?: object, messages?: object[] }} state
 * @param {object} mvu
 * @returns {object} next mvu assigned
 */
export function applyMvuToRuntimeState(state, mvu) {
  if (!state || typeof state !== 'object') {
    throw new Error('applyMvuToRuntimeState: state required')
  }
  const next = isPlainObject(mvu) ? mvu : {}
  state.mvuData = next
  const list = state.messages
  if (Array.isArray(list) && list.length) {
    const last = list[list.length - 1]
    if (last && last.role === 'assistant') {
      last.data = next
      const swipeId = Number.isFinite(Number(last.swipe_id)) ? Number(last.swipe_id) : 0
      if (Array.isArray(last.swipes_data)) {
        last.swipes_data[swipeId] = next
      }
    }
  }
  return next
}
