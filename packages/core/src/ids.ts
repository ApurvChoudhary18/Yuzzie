/**
 * The one place `@yuzie/core` touches a runtime capability.
 *
 * `globalThis.crypto` rather than `node:crypto` keeps the package importable in a
 * browser, which SPEC.md §13.1 requires of everything the SDK depends on. Node 22+
 * exposes the Web Crypto API globally, so no import is needed on either side.
 */
import type { Uuid } from './types.js'

export function newId(): Uuid {
  return globalThis.crypto.randomUUID()
}
