/**
 * Replaced at build time by tsup's `define`. Under vitest the identifier is
 * undeclared, and `typeof` on an undeclared binding is safe in JavaScript, so
 * the dev fallback applies without a ReferenceError.
 */
declare const __YUZIE_VERSION__: string

export const VERSION: string =
  typeof __YUZIE_VERSION__ === 'string' ? __YUZIE_VERSION__ : '0.0.0-dev'
