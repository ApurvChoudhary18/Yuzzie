/**
 * `@yuzie/core` — the single source of truth for the Yuzie domain (SPEC.md §10.2).
 *
 * No I/O lives here. The only runtime capability used is `crypto.randomUUID`,
 * which keeps the package importable in a browser as well as in Node.
 */
export * from './errors.js'
export * from './events.js'
export * from './ids.js'
export * from './rank.js'
export * from './reducer.js'
export * from './schema.js'
export * from './slug.js'
export * from './types.js'
