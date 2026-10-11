---
"@yuzie/server": patch
---

A card number in a URL must be digits: `/cards/1e3` and `/cards/1.5` are a 400 instead of card #1,
and a number too large for the database is a 400 instead of a 500.
