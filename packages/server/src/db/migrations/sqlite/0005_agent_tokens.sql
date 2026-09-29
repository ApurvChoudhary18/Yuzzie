-- Agent tokens (SPEC.md §18 Session 15).
--
-- A token issued to an agent belongs to the agent's user, so every action it
-- takes is attributed to the agent; `created_by` is the person who issued it,
-- who can list and revoke it. `allow_destructive` is the server-side half of
-- §14.2's "Delete card: agent only with --allow-destructive".
ALTER TABLE api_tokens ADD COLUMN created_by text;
ALTER TABLE api_tokens ADD COLUMN allow_destructive integer NOT NULL DEFAULT 0;
CREATE INDEX api_tokens_by_creator ON api_tokens (created_by);
