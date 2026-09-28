-- Watching and activity (SPEC.md §18 Session 14).
--
-- Auto-watch: commenting on a card, or being assigned to it, starts watching
-- it. On by default; a board can turn it off.
ALTER TABLE boards ADD COLUMN auto_watch integer NOT NULL DEFAULT 1;

-- `yuzie activity --card` and the stale filter read one card's events, newest
-- first, without walking the whole board's log.
CREATE INDEX events_by_card ON events (board_id, card_no, seq);
