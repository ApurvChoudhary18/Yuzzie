# @yuzie/server

The [Yuzie](https://github.com/ApurvChoudhary18/Yuzzie) board server: a REST API, the realtime
WebSocket gateway, and Postgres persistence.

Three ways to run it:

- **On your machine:** `yuzie serve`, from the CLI. It runs this package against `DATABASE_URL`,
  or starts a Postgres container with Docker.
- **For a team:** the Docker image `ghcr.io/apurvchoudhary18/yuzie-server` with Postgres, via the
  [self-hosting guide](https://github.com/ApurvChoudhary18/Yuzzie/blob/main/docs/self-hosting.md).
- **Directly:**
  ```sh
  DATABASE_URL=postgres://yuzie:secret@localhost:5432/yuzie npx @yuzie/server
  ```

It applies its database migrations on start, and answers `GET /healthz` and `GET /metrics`
(Prometheus).

| Variable | Default | |
| --- | --- | --- |
| `DATABASE_URL` | (required) | Postgres 16 |
| `PORT`, `HOST` | `8787`, `127.0.0.1` | Where to listen. Use `0.0.0.0` in a container. |
| `YUZIE_PUBLIC_URL` | `http://localhost:<port>` | The address people reach it at |
| `YUZIE_SIGNUP` | `open` | `invite` admits only handles that already exist |
| `YUZIE_GITHUB_CLIENT_ID`, `_SECRET` | (none) | Sign in with GitHub (a GitHub OAuth App) |
| `REDIS_URL` | (none) | Only for more than one server node |
| `LOG_LEVEL` | `info` | JSON logs on stdout |

Deleted accounts are purged 30 days after deletion by a sweep the server runs itself.

The package also exports `buildServer`, `loadConfig`, the migrations and the rest, for embedding
the server or testing against it.

MIT licensed.
