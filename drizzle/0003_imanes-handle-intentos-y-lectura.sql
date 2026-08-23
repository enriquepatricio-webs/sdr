ALTER TABLE "accounts" ADD COLUMN "instagram_username" text;--> statement-breakpoint
ALTER TABLE "lead_magnets" ADD COLUMN "comentarios_leidos_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "magnet_contacts" ADD COLUMN "intentos" integer DEFAULT 0 NOT NULL;