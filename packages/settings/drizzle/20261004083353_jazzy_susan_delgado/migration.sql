ALTER TABLE `settings` ADD `notificationsEnabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `notifyScheduledMergeSettled` integer DEFAULT true NOT NULL;