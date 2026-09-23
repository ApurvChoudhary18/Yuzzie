import { describeCacheConformance } from './__tests__/conformance.js'
import { openJsonCache } from './json-driver.js'

describeCacheConformance({
  kind: 'json',
  open: (location, jitter) =>
    openJsonCache(jitter === undefined ? { location } : { location, jitter }),
})
