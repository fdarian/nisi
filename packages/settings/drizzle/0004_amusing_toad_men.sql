ALTER TABLE `settings` ADD `repoScanRoots` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `repoScanDepth` integer DEFAULT 3 NOT NULL;