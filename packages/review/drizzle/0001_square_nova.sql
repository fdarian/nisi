CREATE TABLE `review_range_claims` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sessionId` integer NOT NULL,
	`path` text NOT NULL,
	`blockId` text NOT NULL,
	`blockLabel` text NOT NULL,
	`ranges` text NOT NULL,
	`snapshotHash` text NOT NULL,
	`viewedAt` integer NOT NULL,
	FOREIGN KEY (`sessionId`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_range_claims_session_path_block_idx` ON `review_range_claims` (`sessionId`,`path`,`blockId`);