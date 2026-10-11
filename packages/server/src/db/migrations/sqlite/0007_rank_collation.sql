-- Ranks are compared byte by byte. SQLite's default BINARY collation already
-- orders them that way, so nothing changes here; this file keeps both
-- dialects' versions in step with the Postgres migration of the same number.
SELECT 1;
