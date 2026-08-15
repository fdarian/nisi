CREATE TABLE `settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`enabledHarnesses` text NOT NULL,
	`sidebarViewMode` text NOT NULL,
	`diffStyleMode` text NOT NULL,
	`updatedAt` integer NOT NULL
);
