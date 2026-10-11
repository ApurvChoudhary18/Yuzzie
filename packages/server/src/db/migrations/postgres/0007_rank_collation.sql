-- Ranks are fractional indexes compared byte by byte (core's rank.ts), so the
-- database must order them the same way. Under a locale collation such as
-- en_US.UTF-8, "b" sorts before "C", and a board's columns and cards came back
-- out of order. COLLATE "C" is byte order whatever the server's locale.
ALTER TABLE columns ALTER COLUMN rank TYPE text COLLATE "C";
ALTER TABLE cards ALTER COLUMN rank TYPE text COLLATE "C";
