CREATE TABLE `scheduled_merges` (
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`number` integer NOT NULL,
	`repo_root` text NOT NULL,
	`route` text NOT NULL,
	`method` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `scheduled_merges_pk` PRIMARY KEY(`owner`, `repo`, `number`)
);
