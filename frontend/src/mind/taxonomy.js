/**
 * Default Mind taxonomy (product defaults; not card-specific).
 * @module mind/taxonomy
 */

/** @type {import('./types.js').MindTaxonomy} */
export const DEFAULT_TAXONOMY = {
  axes: [
    {
      key: 'affect',
      label: 'Affect',
      tags: ['hostile', 'warm', 'fearful', 'curious'],
    },
    {
      key: 'goal',
      label: 'Goal',
      tags: ['protect_x', 'seek_info', 'escape'],
    },
    {
      key: 'knowledge',
      label: 'Knowledge',
      tags: ['knows_user_name', 'saw_event_y', 'unspecified'],
    },
    {
      key: 'relation',
      label: 'Relation',
      tags: ['ally', 'rival', 'stranger', 'debt'],
    },
    {
      key: 'threat',
      label: 'Threat',
      tags: ['low', 'elevated', 'critical'],
    },
  ],
};

/**
 * MVP primary NPC identity.
 * @param {string} [displayName]
 * @returns {import('./types.js').NpcId}
 */
export function createPrimaryNpc(displayName = 'NPC') {
  return {
    id: 'primary',
    displayName: displayName || 'NPC',
    isPrimary: true,
  };
}
