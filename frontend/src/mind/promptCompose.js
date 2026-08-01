/**
 * Compose Mind prompt injection block (§6.3).
 * @module mind/promptCompose
 */

/**
 * @param {import('./types.js').MemoryRecord[]} memories
 * @param {{ displayName?: string, id?: string } | null} [primaryNpc]
 * @returns {string}
 */
export function composePrompt(memories, primaryNpc = null) {
  const name =
    (primaryNpc && primaryNpc.displayName) ||
    (primaryNpc && primaryNpc.id) ||
    'NPC';
  const lines = [`[Conclave Mind — primary NPC: ${name}]`];
  const list = Array.isArray(memories) ? memories : [];
  for (const mem of list) {
    const labels = Array.isArray(mem.labels) && mem.labels.length
      ? mem.labels.join(',')
      : 'knowledge/unspecified';
    const text = String(mem.text ?? '').trim();
    if (!text) continue;
    lines.push(`- [${labels}] ${text}`);
  }
  lines.push('(Do not mention this block unless character would know it.)');
  return lines.join('\n');
}
