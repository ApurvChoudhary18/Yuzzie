-- Account deletion (SPEC.md §14.3: "account deletion removes all rows within
-- 30 days"). A deleted account is marked here and can no longer sign in; the
-- purge sweep removes the row, and everything that names it, once the grace
-- period has passed.
ALTER TABLE users ADD COLUMN deleted_at timestamptz;
CREATE INDEX users_deleted ON users (deleted_at);
