CREATE TABLE "sellers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"website" text,
	"context" text,
	"scraped_context" text,
	"scraped_at" timestamp with time zone,
	"offer" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "seller_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "enrichment" jsonb;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "enriched_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "sellers_name_key" ON "sellers" USING btree ("name");--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE restrict ON UPDATE no action;