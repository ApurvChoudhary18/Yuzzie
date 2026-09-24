-- SPEC.md §12.2: "The client's own events echo back and are deduplicated by
-- idempotencyKey." A live event carries the key, but an event replayed from the
-- log on resume did not, so a client that reconnected mid-write could not
-- recognise its own mutation. The key is now part of the log.

ALTER TABLE events ADD COLUMN idempotency_key text;
