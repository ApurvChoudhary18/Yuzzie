---
"@yuzie/server": patch
---

Columns and cards keep their order on a Postgres whose collation is not byte order, such as
`en_US.UTF-8`. Migration 0007 gives `rank` `COLLATE "C"`.
