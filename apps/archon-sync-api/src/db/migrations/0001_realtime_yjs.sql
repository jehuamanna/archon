CREATE TABLE IF NOT EXISTS "yjs_state" (
	"note_id" uuid PRIMARY KEY NOT NULL,
	"doc_bytes" "bytea" NOT NULL,
	"version" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "yjs_state_updates" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"note_id" uuid NOT NULL,
	"update_bytes" "bytea" NOT NULL,
	"sequence" bigint NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "yjs_state_updates_note_seq_idx" ON "yjs_state_updates" USING btree ("note_id","sequence");