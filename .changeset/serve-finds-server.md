---
"@yuzie/cli": patch
---

`yuzie serve` runs an installed `@yuzie/server` instead of always fetching one through npx: it looked
the package up by its `package.json`, which the package does not export.
