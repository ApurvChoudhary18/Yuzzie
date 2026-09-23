/**
 * The local cache schema (SPEC.md §11.3).
 *
 * `cards`, `columns`, `comments`, `checklist_items` and `git_links` mirror the
 * server tables denormalised, plus the two client-only tables `sync_state` and
 * `outbox`. Every table is keyed by `board_slug` first, because one file can hold
 * more than one board.
 *
 * Small unbounded lists that only ever travel with their card — assignees,
 * labels, watchers, commits, the anchor — are stored as JSON columns. That is
 * what "denormalised" buys: one row read per card instead of five joins.
 */

/** Bumped whenever a migration is appended. Stored in `PRAGMA user_version`. */
export const SCHEMA_VERSION = 1

export interface Migration {
  readonly version: number
  readonly statements: readonly string[]
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE cards (
        board_slug   TEXT    NOT NULL,
        number       INTEGER NOT NULL,
        id           TEXT    NOT NULL,
        board_id     TEXT    NOT NULL,
        column_key   TEXT    NOT NULL,
        rank         TEXT    NOT NULL,
        title        TEXT    NOT NULL,
        description  TEXT,
        priority     INTEGER,
        due_at       TEXT,
        assignees    TEXT    NOT NULL DEFAULT '[]',
        labels       TEXT    NOT NULL DEFAULT '[]',
        watchers     TEXT    NOT NULL DEFAULT '[]',
        commits      TEXT    NOT NULL DEFAULT '[]',
        anchor       TEXT,
        created_by   TEXT,
        archived_at  TEXT,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL,
        version      INTEGER NOT NULL,
        PRIMARY KEY (board_slug, number)
      )`,
      `CREATE INDEX cards_by_column ON cards (board_slug, column_key, rank)`,

      `CREATE TABLE columns (
        board_slug  TEXT NOT NULL,
        key         TEXT NOT NULL,
        id          TEXT NOT NULL,
        board_id    TEXT NOT NULL,
        name        TEXT NOT NULL,
        rank        TEXT NOT NULL,
        semantics   TEXT,
        wip_limit   INTEGER,
        PRIMARY KEY (board_slug, key)
      )`,

      `CREATE TABLE comments (
        board_slug   TEXT NOT NULL,
        id           TEXT NOT NULL,
        card_number  INTEGER NOT NULL,
        author       TEXT NOT NULL,
        body         TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        edited_at    TEXT,
        PRIMARY KEY (board_slug, id)
      )`,
      `CREATE INDEX comments_by_card ON comments (board_slug, card_number, created_at)`,

      `CREATE TABLE checklist_items (
        board_slug   TEXT NOT NULL,
        id           TEXT NOT NULL,
        card_number  INTEGER NOT NULL,
        position     INTEGER NOT NULL,
        text         TEXT NOT NULL,
        done_at      TEXT,
        done_by      TEXT,
        PRIMARY KEY (board_slug, id)
      )`,
      `CREATE INDEX checklist_by_card ON checklist_items (board_slug, card_number, position)`,

      `CREATE TABLE git_links (
        board_slug        TEXT NOT NULL,
        card_number       INTEGER NOT NULL,
        branch            TEXT,
        base_branch       TEXT,
        commit_count      INTEGER NOT NULL DEFAULT 0,
        files_changed     INTEGER NOT NULL DEFAULT 0,
        additions         INTEGER NOT NULL DEFAULT 0,
        deletions         INTEGER NOT NULL DEFAULT 0,
        pushed            INTEGER NOT NULL DEFAULT 0,
        pr_url            TEXT,
        pr_state          TEXT,
        last_activity_at  TEXT,
        PRIMARY KEY (board_slug, card_number)
      )`,

      `CREATE TABLE events (
        board_slug  TEXT    NOT NULL,
        seq         INTEGER NOT NULL,
        type        TEXT    NOT NULL,
        card_no     INTEGER,
        actor       TEXT,
        ts          TEXT    NOT NULL,
        envelope    TEXT    NOT NULL,
        PRIMARY KEY (board_slug, seq)
      )`,

      `CREATE TABLE sync_state (
        board_slug  TEXT PRIMARY KEY,
        last_seq    INTEGER NOT NULL DEFAULT 0,
        synced_at   INTEGER
      )`,

      `CREATE TABLE outbox (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        board_slug       TEXT    NOT NULL,
        op               TEXT    NOT NULL,
        idempotency_key  TEXT    NOT NULL,
        created_at       INTEGER NOT NULL,
        attempts         INTEGER NOT NULL DEFAULT 0,
        last_error       TEXT,
        next_attempt_at  INTEGER
      )`,
      // §11.3 keeps the key inside the `op` JSON; it is lifted into a column so
      // "drain is idempotent given the same keys" can be enforced by the database
      // rather than by every caller remembering to check first.
      `CREATE UNIQUE INDEX outbox_idempotency ON outbox (board_slug, idempotency_key)`,
    ],
  },
]
