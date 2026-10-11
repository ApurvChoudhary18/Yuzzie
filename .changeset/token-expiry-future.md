---
"@yuzie/server": patch
"@yuzie/cli": patch
---

A token cannot be issued already expired: `yuzie token create --expires 0d` is a usage error, and
the server refuses an `expiresAt` in the past before an agent joins the board for it.
