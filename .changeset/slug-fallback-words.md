---
"@yuzie/core": patch
"@yuzie/server": patch
"@yuzie/cli": patch
---

A board or column whose name has no letters or digits (emoji, CJK) gets the slug `board` or the key
`column` instead of `card`. `slugify` takes the fallback word as an optional third argument.
