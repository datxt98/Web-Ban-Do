CREATE TABLE `bando_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_code` text,
	`type` text NOT NULL,
	`message` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bando_events_order_code_idx` ON `bando_events` (`order_code`);--> statement-breakpoint
CREATE INDEX `bando_events_created_at_idx` ON `bando_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `bando_items` (
	`code` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`aliases` text NOT NULL,
	`unit` text DEFAULT 'cai' NOT NULL,
	`sell_price` integer NOT NULL,
	`stock` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bando_items_name_idx` ON `bando_items` (`name`);--> statement-breakpoint
CREATE TABLE `bando_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_code` text NOT NULL,
	`payment_code` text NOT NULL,
	`character_name` text NOT NULL,
	`server_name` text DEFAULT 'default' NOT NULL,
	`item_code` text NOT NULL,
	`item_name` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price` integer NOT NULL,
	`total_amount` integer NOT NULL,
	`status` text DEFAULT 'awaiting_payment' NOT NULL,
	`private_message` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`paid_at` text,
	`delivered_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bando_orders_order_code_idx` ON `bando_orders` (`order_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `bando_orders_payment_code_idx` ON `bando_orders` (`payment_code`);--> statement-breakpoint
CREATE INDEX `bando_orders_status_idx` ON `bando_orders` (`status`);--> statement-breakpoint
CREATE INDEX `bando_orders_character_idx` ON `bando_orders` (`character_name`);--> statement-breakpoint
CREATE TABLE `bando_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_code` text,
	`payment_code` text NOT NULL,
	`amount` integer NOT NULL,
	`status` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bando_transactions_payment_code_idx` ON `bando_transactions` (`payment_code`);--> statement-breakpoint
CREATE INDEX `bando_transactions_order_code_idx` ON `bando_transactions` (`order_code`);