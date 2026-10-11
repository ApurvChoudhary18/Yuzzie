---
"@yuzie/cli": patch
---

Git precondition errors suggest a fix that fits. A failed `finish` says "Fix them, or pass
--skip-checks." instead of naming a `--force` it does not have; a detached HEAD, a missing
repository or review column get their own advice; and `claim --agent` no longer repeats itself.
