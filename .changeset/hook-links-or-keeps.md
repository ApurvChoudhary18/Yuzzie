---
"@yuzie/cli": patch
---

The post-commit hook prints `[yuzie] linked commit …` only once the commit is attached or queued.
Signed out, it keeps the commit for `yuzie sync` instead of dropping it, and the buffer keeps the
whole message, so a `Board-Card:` trailer or `#18` in the body still links it.
