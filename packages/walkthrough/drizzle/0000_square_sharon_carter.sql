CREATE TABLE `walkthroughs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sessionId` text NOT NULL,
	`harness` text NOT NULL,
	`model` text,
	`content` text NOT NULL,
	`fingerprints` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `walkthroughs_sessionId_unique` ON `walkthroughs` (`sessionId`);