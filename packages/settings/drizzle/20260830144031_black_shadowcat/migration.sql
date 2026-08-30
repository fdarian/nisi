CREATE TABLE `repo_merge_methods` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`method` text NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repo_merge_methods_owner_repo_idx` ON `repo_merge_methods` (`owner`,`repo`);