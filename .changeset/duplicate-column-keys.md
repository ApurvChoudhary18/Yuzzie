---
"@yuzie/server": patch
---

Creating a board whose column names share a key — "Todo" and "todo", or two emoji-only names — is a
400 naming the two columns, instead of a 500 from the database's unique index.
