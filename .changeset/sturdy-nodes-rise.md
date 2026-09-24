---
"@yuzie/core": minor
"@yuzie/store": minor
"@yuzie/server": minor
"@yuzie/sdk": minor
"@yuzie/git": minor
"@yuzie/cli": minor
"@yuzie/mcp": minor
---

Require Node 22+, and upgrade better-sqlite3 to 13 to stop a crash on Node 24.19+.

Node 24.19 introduced a regression (nodejs/node#65446, still open): any native addon built
on `node::ObjectWrap` aborts the process with `Assertion failed: (env) != nullptr` when V8
garbage-collects one of its objects. better-sqlite3 11 and 12 are such addons, so on the
current Node LTS an unused `Statement` being collected could kill the process at random. It
was the cause of the intermittent Node 24 CI failures since Session 2.

better-sqlite3 13 moved to N-API and is immune, but it requires Node 22+ (it segfaults on
Node 20), so `engines` is now `>=22` everywhere. Node 20 reached end-of-life in April 2026.
A regression test runs the crashing pattern in a child process.
