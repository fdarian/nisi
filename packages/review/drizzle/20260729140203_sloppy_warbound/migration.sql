-- Hand-written in place of drizzle-kit's generated table recreate, which
-- would destroy every review. Its recreate drops and rebuilds `sessions`,
-- guarded by `PRAGMA foreign_keys=OFF` — but `@repo/db` runs migrations
-- inside a transaction, where that pragma is a no-op, so `DROP TABLE
-- sessions` cascades through `reviewed_files`/`review_range_claims` and
-- empties both. `ALTER TABLE` reaches the same shape without ever dropping
-- the table. Keep `meta/0002_snapshot.json` as generated — that's what
-- future `db:generate` runs diff against.

-- Widen `owner`/`repo` to nullable: they're PR-scoped now, and a repo with no
-- GitHub origin has no such identity. SQLite has no `ALTER COLUMN`, so the
-- nullable pair is added alongside and the NOT NULL pair renamed out of the
-- way, then dropped. Existing values carry over only for rows that have a PR
-- — a no-PR row's `owner`/`repo` described the origin, not a PR, and nothing
-- reads them in that position anymore.
ALTER TABLE `sessions` RENAME COLUMN `owner` TO `owner_notnull`;--> statement-breakpoint
ALTER TABLE `sessions` RENAME COLUMN `repo` TO `repo_notnull`;--> statement-breakpoint
ALTER TABLE `sessions` ADD `owner` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `repo` text;--> statement-breakpoint
UPDATE `sessions` SET `owner` = `owner_notnull`, `repo` = `repo_notnull` WHERE `prNumber` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `owner_notnull`;--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `repo_notnull`;--> statement-breakpoint

-- Re-derive `sessionKey` from `repoRoot` instead of `owner/repo` (see
-- `computeSessionKey`), so existing reviews stay attached to their session
-- rather than being stranded behind a key nothing computes anymore.
UPDATE `sessions` SET `sessionKey` = `repoRoot` || '#pr' || `prNumber` WHERE `prNumber` IS NOT NULL;--> statement-breakpoint
UPDATE `sessions` SET `sessionKey` = `repoRoot` || '#branch' || `headRef` WHERE `prNumber` IS NULL;
