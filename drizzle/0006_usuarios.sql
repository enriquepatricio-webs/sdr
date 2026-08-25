-- Usuarios con nombre y contraseña, en vez de una unica contraseña compartida.
-- La revision de Meta exige credenciales con las que un revisor pueda entrar a
-- ver la app, y darle la del dueño significaria que revocarle el acceso obliga
-- a cambiarsela a todo el mundo.
--
-- La contraseña no se guarda: solo su hash con scrypt y una sal por usuario.
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'admin' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_key" ON "users" USING btree (lower("username"));