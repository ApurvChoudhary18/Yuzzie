-- SPEC.md §11.2, plus the two tables the server needs that the spec describes in
-- prose: device codes for the §12.1 auth flow, and the 24h idempotency store.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle        text UNIQUE NOT NULL,
  email         text UNIQUE,
  display_name  text,
  avatar_url    text,
  kind          text NOT NULL DEFAULT 'human',
  github_login  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text UNIQUE NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE boards (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug             text NOT NULL,
  name             text NOT NULL,
  repo_remote      text,
  base_branch      text NOT NULL DEFAULT 'main',
  branch_template  text NOT NULL DEFAULT 'task/{id}-{slug}',
  next_card_no     integer NOT NULL DEFAULT 1,
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);

-- Board slugs are addressed globally in §12.1 (`/boards/:slug`), so they must be
-- unique across workspaces, not only within one.
CREATE UNIQUE INDEX boards_slug_key ON boards (slug);

CREATE TABLE memberships (
  board_id    uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, user_id)
);

CREATE TABLE columns (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id   uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  key        text NOT NULL,
  name       text NOT NULL,
  rank       text NOT NULL,
  semantics  text,
  wip_limit  integer,
  UNIQUE (board_id, key)
);

CREATE TABLE cards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id     uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  number       integer NOT NULL,
  column_id    uuid NOT NULL REFERENCES columns(id),
  rank         text NOT NULL,
  title        text NOT NULL,
  description  text,
  priority     smallint,
  due_at       timestamptz,
  created_by   uuid REFERENCES users(id),
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      integer NOT NULL DEFAULT 1,
  UNIQUE (board_id, number)
);
CREATE INDEX cards_board_column_rank ON cards (board_id, column_id, rank);

CREATE TABLE card_assignees (
  card_id  uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (card_id, user_id)
);

CREATE TABLE labels (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id  uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name      text NOT NULL,
  color     text,
  UNIQUE (board_id, name)
);

CREATE TABLE card_labels (
  card_id   uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  label_id  uuid NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (card_id, label_id)
);

CREATE TABLE comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id     uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES users(id),
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  edited_at   timestamptz
);
CREATE INDEX comments_by_card ON comments (card_id, created_at);

CREATE TABLE checklist_items (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id   uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  position  integer NOT NULL,
  text      text NOT NULL,
  done_at   timestamptz,
  done_by   uuid REFERENCES users(id)
);
CREATE INDEX checklist_by_card ON checklist_items (card_id, position);

CREATE TABLE watchers (
  card_id  uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (card_id, user_id)
);

CREATE TABLE git_links (
  card_id           uuid PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
  branch            text,
  base_branch       text,
  commit_count      integer NOT NULL DEFAULT 0,
  files_changed     integer NOT NULL DEFAULT 0,
  additions         integer NOT NULL DEFAULT 0,
  deletions         integer NOT NULL DEFAULT 0,
  pushed            boolean NOT NULL DEFAULT false,
  pr_url            text,
  pr_state          text,
  last_activity_at  timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commits (
  sha           text NOT NULL,
  card_id       uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  author_id     uuid REFERENCES users(id),
  message       text,
  committed_at  timestamptz,
  PRIMARY KEY (card_id, sha)
);

CREATE TABLE anchors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id         uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  path            text NOT NULL,
  line            integer,
  end_line        integer,
  commit_sha      text,
  primary_anchor  boolean NOT NULL DEFAULT false
);
CREATE INDEX anchors_by_card ON anchors (card_id);

CREATE TABLE events (
  board_id    uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  seq         bigint NOT NULL,
  id          uuid NOT NULL,
  type        text NOT NULL,
  actor_id    uuid REFERENCES users(id),
  card_id     uuid,
  card_no     integer,
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, seq)
);

CREATE TABLE api_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  board_id      uuid REFERENCES boards(id) ON DELETE CASCADE,
  name          text NOT NULL,
  token_hash    text NOT NULL,
  role          text NOT NULL,
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX api_tokens_hash ON api_tokens (token_hash);

-- Device-code flow (§12.1 POST /auth/device). Short-lived by construction.
CREATE TABLE device_codes (
  device_code  text PRIMARY KEY,
  user_code    text UNIQUE NOT NULL,
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  approved_at  timestamptz,
  consumed_at  timestamptz,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- §12.1: "The server stores the key -> response for 24 h."
CREATE TABLE idempotency_keys (
  key           text NOT NULL,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method        text NOT NULL,
  path          text NOT NULL,
  request_hash  text NOT NULL,
  status        integer,
  response      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, user_id)
);
CREATE INDEX idempotency_expiry ON idempotency_keys (created_at);
