---
"@yuzie/core": patch
"@yuzie/sdk": patch
"@yuzie/cli": patch
---

A missing checklist item points at the card's checklist instead of saying "Run `yuzie list` to see
card ids". `BoardError` takes an optional `fix` for a hint more specific than its code's.
