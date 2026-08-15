CREATE TABLE `reviewed_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sessionId` integer NOT NULL,
	`path` text NOT NULL,
	`viewed` integer NOT NULL,
	`snapshotHash` text,
	`viewedAt` integer NOT NULL,
	FOREIGN KEY (`sessionId`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviewed_files_session_path_idx` ON `reviewed_files` (`sessionId`,`path`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`publicId` text NOT NULL,
	`sessionKey` text NOT NULL,
	`repoRoot` text NOT NULL,
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`prNumber` integer,
	`prTitle` text,
	`baseRef` text NOT NULL,
	`headRef` text NOT NULL,
	`closedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_publicId_unique` ON `sessions` (`publicId`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_sessionKey_unique` ON `sessions` (`sessionKey`);