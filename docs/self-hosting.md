# Self-hosting Yuzie

Yuzie's server is one container plus Postgres. This guide runs both with Docker Compose on any
machine with Docker, and points the CLI at them. It takes about two minutes.

> **Every `sh` block on this page runs in CI, in order, exactly as written** (the `self-host`
> job in `.github/workflows/ci.yml`), and then an end-to-end run is made against the result. If
> this page is wrong, the build is red.

> **Just trying it?** `yuzie serve` runs the server on your own machine. It uses your
> `DATABASE_URL`, or starts a Postgres container with Docker. This guide is for a server your
> team shares.

## What you need

- Docker with the Compose plugin (`docker compose version` prints 2.20 or later).
- `openssl` and `curl`, for generating a password and checking the server.
- Port 8787 free, or pick another with `YUZIE_PORT` below.

## 1. Write the compose file

Make a directory for the deployment and put the compose file in it. This is the same file as
[`deploy/docker-compose.yml`](../deploy/docker-compose.yml) in the repository.

```sh
mkdir -p yuzie-server && cd yuzie-server
cat > docker-compose.yml <<'YAML'
# Yuzie, self-hosted (SPEC.md §14.3): the server and its Postgres, one file.
# docs/self-hosting.md walks through it; the guide's copy of this file must stay
# identical (a test checks).
#
#   docker compose up -d --wait
#
# Needs a .env beside it with POSTGRES_PASSWORD (and YUZIE_PUBLIC_URL when the
# server is reached at anything but http://localhost:8787).

name: yuzie

services:
  server:
    image: ${YUZIE_IMAGE:-ghcr.io/apurvchoudhary18/yuzie-server:latest}
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://yuzie:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}@postgres:5432/yuzie
      YUZIE_PUBLIC_URL: ${YUZIE_PUBLIC_URL:-http://localhost:8787}
      YUZIE_SIGNUP: ${YUZIE_SIGNUP:-open}
      LOG_LEVEL: ${LOG_LEVEL:-info}
    ports:
      - "${YUZIE_PORT:-8787}:8787"

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: yuzie
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: yuzie
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U yuzie -d yuzie"]
      interval: 5s
      timeout: 5s
      retries: 20

volumes:
  pgdata:
YAML
```

## 2. Choose a database password

Compose reads `.env` beside the file. The password never leaves this machine.

```sh
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > .env
```

Other settings, all optional, go in the same file:

| Variable | Default | What it does |
| --- | --- | --- |
| `YUZIE_PUBLIC_URL` | `http://localhost:8787` | The address people reach the server at. The sign-in page is advertised here. Set it to your real URL behind a proxy. |
| `YUZIE_PORT` | `8787` | The port on this machine. |
| `YUZIE_SIGNUP` | `open` | `open` lets anyone who can reach the server sign in and become a user. `invite` only lets in handles that already exist. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. Logs are JSON on stdout. |
| `YUZIE_IMAGE` | `ghcr.io/apurvchoudhary18/yuzie-server:latest` | Pin a version here, e.g. `…/yuzie-server:0.1.0`. |

## 3. Start it

```sh
docker compose up -d --wait
```

`--wait` returns once Postgres and the server both report healthy. The server applies its
database migrations on start, so there is no separate migration step, on first run or after an
upgrade.

## 4. Check it

```sh
curl -fsS http://localhost:8787/healthz
```

It answers `{"status":"ok","version":"yuzie/v1"}`. Prometheus metrics are at `/metrics`.

## 5. Point the CLI at it

On each teammate's machine, tell `yuzie` where the server is, then set a repository up as usual:

```console
$ export YUZIE_SERVER=http://localhost:8787/v1     # or your YUZIE_PUBLIC_URL, plus /v1
$ cd ~/code/payments-api
$ npx yuzie@latest init
```

`init` writes the server into `.yuzie/config.json`, so everyone who clones the repository after
that uses the same server without setting anything.

**Signing in.** `yuzie login` (and `init`) prints a code and a link to the server's device
page. With no GitHub app configured, a self-hosted server approves a code with a handle: the
person posts their code and the handle they want to the server.

```console
$ curl -X POST http://localhost:8787/v1/auth/device/approve \
    -H 'content-type: application/json' \
    -d '{"userCode":"WXYZ-4821","handle":"rahul"}'
```

With `YUZIE_SIGNUP=open` this creates `@rahul` on first use. Put the server behind your VPN or an
authenticating proxy if it is reachable from the internet. Anyone who can reach it can sign up.

## Running it for real

- **TLS.** Terminate HTTPS in front of the server with Caddy, nginx or your load balancer, and
  forward WebSocket upgrades on `/v1/boards/*/stream`. Then set `YUZIE_PUBLIC_URL` to the
  `https://` address.
- **Backups.** Everything is in Postgres, in the `pgdata` volume. Back it up with
  `docker compose exec postgres pg_dump -U yuzie yuzie > yuzie.sql`.
- **Upgrades.** Run `docker compose pull && docker compose up -d --wait`. Migrations run on start
  and only move forward, so take a backup first.
- **More than one server node.** Add Redis and set `REDIS_URL` on every node. Realtime events
  then fan out across nodes. One node needs neither.
- **Rate limits.** Each token may make 600 reads and 120 writes a minute (SPEC §12.1).

## Stopping and removing

```console
$ docker compose down          # stop; data is kept in the pgdata volume
$ docker compose down -v       # stop and delete all data
```
