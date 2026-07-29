PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`enabledHarnesses` text,
	`sidebarViewMode` text NOT NULL,
	`diffStyleMode` text NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_settings`("id", "enabledHarnesses", "sidebarViewMode", "diffStyleMode", "updatedAt") SELECT "id", "enabledHarnesses", "sidebarViewMode", "diffStyleMode", "updatedAt" FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;