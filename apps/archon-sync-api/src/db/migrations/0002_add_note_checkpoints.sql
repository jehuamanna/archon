CREATE TABLE IF NOT EXISTS "note_checkpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"note_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"label" text,
	"pinned" boolean DEFAULT false NOT NULL,
	"yjs_state" "bytea" NOT NULL,
	"content_text" text NOT NULL,
	"content_sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "note_checkpoints" ADD CONSTRAINT "note_checkpoints_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "note_checkpoints" ADD CONSTRAINT "note_checkpoints_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "note_checkpoints_note_created_idx" ON "note_checkpoints" USING btree ("note_id","created_at_ms");