-- Instagram vuelve, ahora por la API oficial de Meta en vez de por Unipile.
-- El token es por cuenta y dura 60 dias renovables; la fecha esta para poder
-- avisar ANTES de que caduque, en vez de descubrirlo el dia que un comentario
-- se queda sin contestar.
ALTER TABLE "accounts" ADD COLUMN "meta_token" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "meta_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "ig_user_id" text;