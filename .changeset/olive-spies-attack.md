---
"@yuzie/server": patch
"@yuzie/store": patch
"@yuzie/core": patch
---

Audit of Sessions 0–3: fix three defects and make two tests honest.

- **`@yuzie/server`**: a POST with `Content-Type: application/json` and an empty body
  answered 400. That is what `fetch` sends for a payload-free POST, so `POST /auth/device`
  was unusable from any normal client. An empty JSON body is now `{}`. Found only because
  the suite had never driven the server over a real socket — it now does.
- **`@yuzie/core`**: `branchFor` rendered `task/NaN-…` for a card number that failed to
  parse. That is a *valid* Git ref, so nothing downstream would have caught it. It now
  rejects a number that is not a positive integer.
- **`@yuzie/store`**: the SQLite→JSON fallback (§20's mitigation for "native build
  failures break npx") was never actually exercised. It is now, from a process where
  `better-sqlite3` genuinely cannot resolve.
- **`@yuzie/store`**: child rows are decoded positionally like card rows, cutting the
  2,000-card read from 16.7ms to 7.5ms of CPU.
- The performance budget moved out of `test` into its own `bench` task, run with
  concurrency 1. Measured inside the parallel pipeline it reported 19.7ms against a 20ms
  budget; run alone it reports 7.5ms. It was measuring the machine.
