CREATE TABLE `harness_model_discoveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`harnessId` text NOT NULL UNIQUE,
	`modelsJson` text,
	`fetchedAt` integer,
	`lastAttemptAt` integer NOT NULL,
	`consecutiveFailures` integer DEFAULT 0 NOT NULL,
	`lastError` text
);
