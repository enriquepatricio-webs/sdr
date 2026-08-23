CREATE TYPE "public"."account_status" AS ENUM('active', 'paused', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'running', 'paused', 'done');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('linkedin', 'email', 'instagram');--> statement-breakpoint
CREATE TYPE "public"."icp_verdict" AS ENUM('encaja', 'dudoso', 'no_encaja');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('nuevo', 'contactado', 'en_seguimiento', 'respondido', 'cualificando', 'cualificado', 'descartado', 'agendado', 'no_interesado', 'error', 'revision_humana');--> statement-breakpoint
CREATE TYPE "public"."log_level" AS ENUM('debug', 'info', 'warn', 'error');--> statement-breakpoint
CREATE TYPE "public"."meeting_status" AS ENUM('booked', 'cancelled', 'completed', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."prospect_decision" AS ENUM('pendiente', 'importado', 'descartado');--> statement-breakpoint
CREATE TYPE "public"."search_origin" AS ENUM('manual', 'automatica');--> statement-breakpoint
CREATE TYPE "public"."search_status" AS ENUM('pendiente', 'ejecutando', 'puntuando', 'completada', 'fallida');--> statement-breakpoint
CREATE TYPE "public"."touch_direction" AS ENUM('out', 'in');--> statement-breakpoint
CREATE TYPE "public"."touch_status" AS ENUM('borrador', 'enviado', 'fallido');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unipile_account_id" text NOT NULL,
	"provider" "channel" NOT NULL,
	"display_name" text NOT NULL,
	"daily_limit" integer DEFAULT 25 NOT NULL,
	"hourly_limit" integer,
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_id_provider_key" UNIQUE("id","provider"),
	CONSTRAINT "accounts_daily_limit_range" CHECK ("accounts"."daily_limit" > 0 AND "accounts"."daily_limit" <= 80),
	CONSTRAINT "accounts_hourly_limit_range" CHECK ("accounts"."hourly_limit" IS NULL OR ("accounts"."hourly_limit" > 0 AND "accounts"."hourly_limit" <= 20)),
	CONSTRAINT "accounts_hourly_below_daily" CHECK ("accounts"."hourly_limit" IS NULL OR "accounts"."hourly_limit" <= "accounts"."daily_limit")
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"icp_id" uuid,
	"playbook_id" uuid,
	"account_id" uuid,
	"channel" "channel" NOT NULL,
	"daily_cap" integer DEFAULT 25 NOT NULL,
	"sending_window" jsonb NOT NULL,
	"followup_delays" jsonb DEFAULT '[3,5,7]'::jsonb NOT NULL,
	"max_touches" integer DEFAULT 4 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_running_is_executable" CHECK ("campaigns"."status" <> 'running' OR ("campaigns"."account_id" IS NOT NULL AND "campaigns"."playbook_id" IS NOT NULL)),
	CONSTRAINT "campaigns_daily_cap_range" CHECK ("campaigns"."daily_cap" > 0 AND "campaigns"."daily_cap" <= 80),
	CONSTRAINT "campaigns_max_touches_range" CHECK ("campaigns"."max_touches" > 0 AND "campaigns"."max_touches" <= 10)
);
--> statement-breakpoint
CREATE TABLE "icps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disqualifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"headline" text,
	"company" text,
	"linkedin_url" text,
	"email" text,
	"instagram_username" text,
	"provider_id" text,
	"status" "lead_status" DEFAULT 'nuevo' NOT NULL,
	"score" integer,
	"qualification" jsonb,
	"touch_count" integer DEFAULT 0 NOT NULL,
	"next_action_at" timestamp with time zone,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_score_range" CHECK ("leads"."score" IS NULL OR ("leads"."score" >= 0 AND "leads"."score" <= 100)),
	CONSTRAINT "leads_touch_count_positive" CHECK ("leads"."touch_count" >= 0),
	CONSTRAINT "leads_contactable" CHECK ("leads"."linkedin_url" IS NOT NULL OR "leads"."email" IS NOT NULL
          OR "leads"."instagram_username" IS NOT NULL OR "leads"."provider_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"composio_event_id" text,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"meet_url" text,
	"status" "meeting_status" DEFAULT 'booked' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meetings_end_after_start" CHECK ("meetings"."end_at" > "meetings"."start_at")
);
--> statement-breakpoint
CREATE TABLE "playbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"system_prompt" text NOT NULL,
	"offer" text NOT NULL,
	"qualification_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"objections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"booking_rules" jsonb NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospect_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"icp_id" uuid NOT NULL,
	"campaign_id" uuid,
	"name" text NOT NULL,
	"source" "channel" NOT NULL,
	"brief" text,
	"origin" "search_origin" DEFAULT 'manual' NOT NULL,
	"angle" text,
	"auto_import" boolean DEFAULT false NOT NULL,
	"actor" text NOT NULL,
	"input" jsonb NOT NULL,
	"input_reasoning" text,
	"apify_run_id" text,
	"apify_dataset_id" text,
	"status" "search_status" DEFAULT 'pendiente' NOT NULL,
	"stats" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"search_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"headline" text,
	"company" text,
	"location" text,
	"linkedin_url" text,
	"instagram_username" text,
	"email" text,
	"provider_id" text,
	"icp_score" integer,
	"icp_verdict" "icp_verdict",
	"icp_reasoning" text,
	"decision" "prospect_decision" DEFAULT 'pendiente' NOT NULL,
	"lead_id" uuid,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prospects_icp_score_range" CHECK ("prospects"."icp_score" IS NULL OR ("prospects"."icp_score" >= 0 AND "prospects"."icp_score" <= 100)),
	CONSTRAINT "prospects_contactable" CHECK ("prospects"."linkedin_url" IS NOT NULL OR "prospects"."instagram_username" IS NOT NULL
          OR "prospects"."email" IS NOT NULL OR "prospects"."provider_id" IS NOT NULL),
	CONSTRAINT "prospects_imported_has_lead" CHECK ("prospects"."decision" <> 'importado' OR "prospects"."lead_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "run_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow" text NOT NULL,
	"lead_id" uuid,
	"level" "log_level" DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "touches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"account_id" uuid,
	"step" integer DEFAULT 1 NOT NULL,
	"channel" "channel" NOT NULL,
	"direction" "touch_direction" NOT NULL,
	"status" "touch_status" DEFAULT 'borrador' NOT NULL,
	"body" text NOT NULL,
	"unipile_message_id" text,
	"unipile_chat_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "touches_sent_at_matches_status" CHECK (("touches"."status" = 'enviado') = ("touches"."sent_at" IS NOT NULL)),
	CONSTRAINT "touches_inbound_is_sent" CHECK ("touches"."direction" = 'out' OR "touches"."status" = 'enviado')
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_icp_id_icps_id_fk" FOREIGN KEY ("icp_id") REFERENCES "public"."icps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_account_channel_fk" FOREIGN KEY ("account_id","channel") REFERENCES "public"."accounts"("id","provider") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_searches" ADD CONSTRAINT "prospect_searches_icp_id_icps_id_fk" FOREIGN KEY ("icp_id") REFERENCES "public"."icps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_searches" ADD CONSTRAINT "prospect_searches_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_search_id_prospect_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."prospect_searches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_logs" ADD CONSTRAINT "run_logs_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "touches" ADD CONSTRAINT "touches_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "touches" ADD CONSTRAINT "touches_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_unipile_account_id_key" ON "accounts" USING btree ("unipile_account_id");--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "leads_campaign_status_idx" ON "leads" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "leads_next_action_at_idx" ON "leads" USING btree ("next_action_at") WHERE "leads"."status" NOT IN ('descartado','agendado','no_interesado','error','revision_humana');--> statement-breakpoint
CREATE INDEX "leads_provider_id_idx" ON "leads" USING btree ("provider_id") WHERE "leads"."provider_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "leads_campaign_linkedin_url_key" ON "leads" USING btree ("campaign_id",regexp_replace(lower("linkedin_url"), '^https?://(www\.)?|/+$', '', 'g')) WHERE "leads"."linkedin_url" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "leads_campaign_email_key" ON "leads" USING btree ("campaign_id",lower("email")) WHERE "leads"."email" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "leads_campaign_instagram_key" ON "leads" USING btree ("campaign_id",lower(btrim("instagram_username", ' @'))) WHERE "leads"."instagram_username" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "leads_campaign_provider_id_key" ON "leads" USING btree ("campaign_id","provider_id") WHERE "leads"."provider_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "meetings_start_at_idx" ON "meetings" USING btree ("start_at");--> statement-breakpoint
CREATE INDEX "meetings_lead_id_idx" ON "meetings" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_composio_event_id_key" ON "meetings" USING btree ("composio_event_id") WHERE "meetings"."composio_event_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "playbooks_name_version_key" ON "playbooks" USING btree ("name","version");--> statement-breakpoint
CREATE UNIQUE INDEX "playbooks_single_active_key" ON "playbooks" USING btree ("is_active") WHERE "playbooks"."is_active";--> statement-breakpoint
CREATE INDEX "prospect_searches_status_idx" ON "prospect_searches" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "prospect_searches_origin_created_at_idx" ON "prospect_searches" USING btree ("origin","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "prospect_searches_apify_run_id_key" ON "prospect_searches" USING btree ("apify_run_id") WHERE "prospect_searches"."apify_run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "prospects_search_decision_score_idx" ON "prospects" USING btree ("search_id","decision","icp_score");--> statement-breakpoint
CREATE INDEX "prospects_lead_id_idx" ON "prospects" USING btree ("lead_id") WHERE "prospects"."lead_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "prospects_search_linkedin_key" ON "prospects" USING btree ("search_id",regexp_replace(lower("linkedin_url"), '^https?://(www\.)?|/+$', '', 'g')) WHERE "prospects"."linkedin_url" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "prospects_search_instagram_key" ON "prospects" USING btree ("search_id",lower(btrim("instagram_username", ' @'))) WHERE "prospects"."instagram_username" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "run_logs_workflow_created_at_idx" ON "run_logs" USING btree ("workflow","created_at");--> statement-breakpoint
CREATE INDEX "run_logs_lead_id_created_at_idx" ON "run_logs" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "run_logs_level_created_at_idx" ON "run_logs" USING btree ("level","created_at");--> statement-breakpoint
CREATE INDEX "touches_lead_id_created_at_idx" ON "touches" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "touches_unipile_message_id_key" ON "touches" USING btree ("unipile_message_id") WHERE "touches"."unipile_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "touches_unipile_chat_id_idx" ON "touches" USING btree ("unipile_chat_id") WHERE "touches"."unipile_chat_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "touches_account_sent_at_idx" ON "touches" USING btree ("account_id","sent_at") WHERE "touches"."direction" = 'out' AND "touches"."sent_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "touches_borradores_idx" ON "touches" USING btree ("created_at") WHERE "touches"."status" = 'borrador';