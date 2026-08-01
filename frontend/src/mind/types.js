/**
 * Mind types (JSDoc). See docs/architecture-host-mind.md §6.2.
 * @module mind/types
 */

/**
 * @typedef {Object} NpcId
 * @property {string} id
 * @property {string} displayName
 * @property {boolean} isPrimary
 */

/**
 * @typedef {Object} TaxonomyAxis
 * @property {string} key
 * @property {string} label
 * @property {string[]} tags
 * @property {number} [maxActive]
 */

/**
 * @typedef {Object} MindTaxonomy
 * @property {TaxonomyAxis[]} axes
 */

/**
 * @typedef {Object} MemoryRecord
 * @property {string} id
 * @property {string} npcId
 * @property {string} sessionId
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} [sourceMessageId]
 * @property {string} text
 * @property {string[]} labels
 * @property {Record<string, number>} scores
 * @property {string} contentHash
 * @property {'active'|'archived'|'purged'} status
 * @property {number} lastAccessedAt
 * @property {number} accessCount
 */

/**
 * @typedef {Object} MindCleanupStats
 * @property {number} lastRunAt
 * @property {number} removedDedupe
 * @property {number} removedExpired
 * @property {number} activeCount
 */

/**
 * @typedef {Object} MindInjectionDebug
 * @property {string} content
 * @property {number} chars
 * @property {number} at
 * @property {number} memoryCount
 */

/**
 * @typedef {Object} MindSnapshot
 * @property {NpcId[]} npcs
 * @property {MindTaxonomy} taxonomy
 * @property {MemoryRecord[]} memories
 * @property {MindCleanupStats} cleanup
 * @property {MindInjectionDebug|null} lastInjection
 */

export {};
