CREATE TYPE "public"."magnet_state" AS ENUM('detectado', 'pidiendo_follow', 'verificado', 'entregado', 'en_conversacion', 'descartado');--> statement-breakpoint
CREATE TABLE "followers" (
	"account_id" uuid NOT NULL,
	"username" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "followers_account_id_username_pk" PRIMARY KEY("account_id","username")
);
--> statement-breakpoint
CREATE TABLE "lead_magnets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"post_url" text NOT NULL,
	"keyword" text NOT NULL,
	"resource" text NOT NULL,
	"follow_message" text NOT NULL,
	"pitch_meeting" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "magnet_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"magnet_id" uuid NOT NULL,
	"username" text NOT NULL,
	"full_name" text,
	"comment_id" text,
	"provider_id" text,
	"unipile_chat_id" text,
	"state" "magnet_state" DEFAULT 'detectado' NOT NULL,
	"follow_asks" integer DEFAULT 0 NOT NULL,
	"verified_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"lead_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "playbooks_single_active_key";--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_id_workspace_key" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "sellers" ADD CONSTRAINT "workspaces_id_key" UNIQUE("id");--> statement-breakpoint
ALTER TABLE "icps" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "playbooks" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "prospect_searches" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "autopilot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "telegram_chat_id" text;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "lessons" jsonb;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "auto_prospect" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "auto_prospect_min_leads" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "auto_prospect_max_items" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "auto_prospect_min_score" integer DEFAULT 70 NOT NULL;--> statement-breakpoint
ALTER TABLE "followers" ADD CONSTRAINT "followers_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_magnets" ADD CONSTRAINT "lead_magnets_workspace_id_sellers_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."sellers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_magnets" ADD CONSTRAINT "lead_magnets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_magnets" ADD CONSTRAINT "lead_magnets_account_workspace_fk" FOREIGN KEY ("account_id","workspace_id") REFERENCES "public"."accounts"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magnet_contacts" ADD CONSTRAINT "magnet_contacts_magnet_id_lead_magnets_id_fk" FOREIGN KEY ("magnet_id") REFERENCES "public"."lead_magnets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magnet_contacts" ADD CONSTRAINT "magnet_contacts_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "followers_seen_idx" ON "followers" USING btree ("account_id","seen_at");--> statement-breakpoint
CREATE INDEX "lead_magnets_activos_idx" ON "lead_magnets" USING btree ("active","last_checked_at") WHERE "lead_magnets"."active";--> statement-breakpoint
CREATE INDEX "lead_magnets_workspace_idx" ON "lead_magnets" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "magnet_contacts_magnet_username_key" ON "magnet_contacts" USING btree ("magnet_id","username");--> statement-breakpoint
CREATE INDEX "magnet_contacts_cola_idx" ON "magnet_contacts" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "magnet_contacts_comment_key" ON "magnet_contacts" USING btree ("comment_id") WHERE "magnet_contacts"."comment_id" IS NOT NULL;--> statement-breakpoint
--> Relleno. Las filas que ya existen se quedarían con workspace_id NULL y la
--> clave compuesta campaigns(account_id, seller_id) -> accounts(id, workspace_id)
--> fallaría al crearse. Se asignan al primer workspace, que hoy es el único.
UPDATE "accounts" SET "workspace_id" = (SELECT "id" FROM "sellers" ORDER BY "created_at" LIMIT 1) WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "icps" SET "workspace_id" = (SELECT "id" FROM "sellers" ORDER BY "created_at" LIMIT 1) WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "prospect_searches" SET "workspace_id" = (SELECT "id" FROM "sellers" ORDER BY "created_at" LIMIT 1) WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "campaigns" SET "seller_id" = (SELECT "id" FROM "sellers" ORDER BY "created_at" LIMIT 1) WHERE "seller_id" IS NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_workspace_id_sellers_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."sellers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_account_workspace_fk" FOREIGN KEY ("account_id","seller_id") REFERENCES "public"."accounts"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icps" ADD CONSTRAINT "icps_workspace_id_sellers_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."sellers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_workspace_id_sellers_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."sellers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_searches" ADD CONSTRAINT "prospect_searches_workspace_id_sellers_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."sellers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_workspace_idx" ON "accounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "campaigns_workspace_idx" ON "campaigns" USING btree ("seller_id");--> statement-breakpoint
CREATE UNIQUE INDEX "playbooks_activo_global" ON "playbooks" USING btree ("is_active") WHERE "playbooks"."is_active" AND "playbooks"."workspace_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "playbooks_activo_por_workspace" ON "playbooks" USING btree ("workspace_id") WHERE "playbooks"."is_active" AND "playbooks"."workspace_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "playbooks_workspace_idx" ON "playbooks" USING btree ("workspace_id");