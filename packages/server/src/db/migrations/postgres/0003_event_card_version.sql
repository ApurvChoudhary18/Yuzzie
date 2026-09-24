-- The card's version after each event. The server bumps a card's version on
-- every mutation; storing it with the event lets a client that rebuilds state
-- from the log (on resume, or from `GET /events`) hold the same version a
-- snapshot would, so its next `If-Match` does not conflict spuriously.

ALTER TABLE events ADD COLUMN card_version integer;
