---
"@yuzie/cli": patch
---

Under `--json`, a usage error (a bad flag or argument) reports `code: "validation_failed"`, as
Appendix C says, instead of `"internal"`.
