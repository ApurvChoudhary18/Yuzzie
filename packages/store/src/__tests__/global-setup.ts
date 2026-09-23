/**
 * Compile the package once, before any test file runs, for the suites that need
 * to drive it from a separate process.
 */
import { buildRunnableBundle, removeRunnableBundle } from './bundle.js'

export function setup(): void {
  buildRunnableBundle()
}

export function teardown(): void {
  removeRunnableBundle()
}
