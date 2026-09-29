/**
 * The `yuzie` binary's entry: as small as possible, so V8's on-disk compile
 * cache is on before the rest of the CLI is loaded (§18 Session 16). The next
 * run then skips compiling it. `NODE_DISABLE_COMPILE_CACHE=1` turns it off.
 */
import { enableCompileCache } from 'node:module'

try {
  enableCompileCache?.()
} catch {
  // An unwritable cache directory just means compiling as before.
}
const { main } = await import('./main.js')
main()
