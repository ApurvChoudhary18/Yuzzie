---
"@yuzie/cli": minor
"@yuzie/sdk": minor
"@yuzie/server": patch
---

There is no hosted Yuzie, so nothing points at one.

- **Default server.** The CLI and the SDK now default to `http://localhost:8787/v1`, where
  `yuzie serve` listens, not to `api.yuzie.dev`. When nothing answers there, the error says to
  run `yuzie serve` or set `YUZIE_SERVER`. A team's server is still set with `YUZIE_SERVER` or
  `server` in `.yuzie/config.json`.
- **Optional Redis.** The self-hosting compose file has it as a profile (§17): set
  `COMPOSE_PROFILES=redis` and `REDIS_URL=redis://redis:6379`. The server treats an empty
  environment variable as unset.
- **A `next` release channel** (§17). A manual run of the release workflow publishes a snapshot
  of main under the npm `next` tag, for `npx yuzie@next`.
