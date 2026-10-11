---
"@yuzie/cli": patch
---

Under `--json`, a missing argument or an unknown option prints one `Error` document on stdout,
naming the command's `--help`, instead of Commander's plain-text error and no document.
