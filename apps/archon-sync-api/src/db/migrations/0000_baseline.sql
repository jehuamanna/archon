CREATE TABLE IF NOT EXISTS "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"metadata" jsonb,
	"ts" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legacy_object_id_map" (
	"scope" text NOT NULL,
	"legacy_id" text NOT NULL,
	"new_id" uuid NOT NULL,
	CONSTRAINT "legacy_object_id_map_scope_legacy_id_pk" PRIMARY KEY("scope","legacy_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_device_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_code" text NOT NULL,
	"device_code_hash" text NOT NULL,
	"status" text NOT NULL,
	"client_ip" "inet" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"bound_user_id" uuid,
	"issued_access_token" text,
	"issued_refresh_token" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mdx_state_chunks" (
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"head_version" integer NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "mdx_state_chunks_project_id_key_chunk_index_head_version_pk" PRIMARY KEY("project_id","key","chunk_index","head_version")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mdx_state_head" (
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"mode" text NOT NULL,
	"value" jsonb,
	"total_chunks" integer,
	"total_bytes" bigint NOT NULL,
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	"updated_by_email" text NOT NULL,
	CONSTRAINT "mdx_state_head_project_id_key_pk" PRIMARY KEY("project_id","key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mdx_state_ws_cursors" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"resume_token" jsonb,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "note_edges" (
	"src" uuid NOT NULL,
	"dst" uuid NOT NULL,
	"kind" text DEFAULT 'link' NOT NULL,
	"meta" jsonb,
	CONSTRAINT "note_edges_src_dst_kind_pk" PRIMARY KEY("src","dst","kind")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notes" (
	"id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted" boolean NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"type" text NOT NULL,
	CONSTRAINT "notes_id_user_id_pk" PRIMARY KEY("id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"link" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"read_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"dedupe_key" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"declined_at" timestamp with time zone,
	"declined_by_user_id" uuid,
	"space_grants" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_memberships" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	CONSTRAINT "org_memberships_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"added_by_user_id" uuid NOT NULL,
	"added_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "space_announcements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"content_markdown" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "space_memberships" (
	"space_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"added_by_user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	CONSTRAINT "space_memberships_space_id_user_id_pk" PRIMARY KEY("space_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "spaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"hidden" boolean,
	"hidden_at" timestamp with time zone,
	"hidden_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team_memberships" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"added_by_user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	CONSTRAINT "team_memberships_team_id_user_id_pk" PRIMARY KEY("team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team_space_grants" (
	"team_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"role" text NOT NULL,
	"granted_by_user_id" uuid NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "team_space_grants_team_id_space_id_pk" PRIMARY KEY("team_id","space_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "teams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color_token" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_prefs" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"shell_layout" jsonb,
	"updated_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"active_refresh_jti" text,
	"refresh_sessions" jsonb,
	"default_org_id" uuid,
	"last_active_org_id" uuid,
	"last_active_space_id" uuid,
	"last_active_space_by_org" jsonb,
	"locked_org_id" uuid,
	"is_master_admin" boolean,
	"disabled" boolean,
	"display_name" text,
	"must_set_password" boolean
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"added_by_user_id" uuid NOT NULL,
	"added_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wpn_explorer_state" (
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"space_id" uuid,
	"project_id" uuid NOT NULL,
	"expanded_ids" jsonb NOT NULL,
	CONSTRAINT "wpn_explorer_state_user_id_project_id_pk" PRIMARY KEY("user_id","project_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wpn_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"space_id" uuid,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"project_id" uuid NOT NULL,
	"parent_id" uuid,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb,
	"sibling_index" integer NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"deleted" boolean
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wpn_projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"space_id" uuid,
	"workspace_id" uuid NOT NULL,
	"visibility" text,
	"creator_user_id" uuid,
	"name" text NOT NULL,
	"sort_index" integer NOT NULL,
	"color_token" text,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"settings" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wpn_workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"space_id" uuid,
	"visibility" text,
	"creator_user_id" uuid,
	"name" text NOT NULL,
	"sort_index" integer NOT NULL,
	"color_token" text,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"settings" jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_org_ts_idx" ON "audit_events" USING btree ("org_id","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_target_ts_idx" ON "audit_events" USING btree ("target_type","target_id","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legacy_object_id_map_scope_new_id_idx" ON "legacy_object_id_map" USING btree ("scope","new_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_device_sessions_user_code_unique" ON "mcp_device_sessions" USING btree ("user_code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_device_sessions_device_code_hash_unique" ON "mcp_device_sessions" USING btree ("device_code_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_device_sessions_bound_status_expires_idx" ON "mcp_device_sessions" USING btree ("bound_user_id","status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mdx_state_chunks_project_key_version_idx" ON "mdx_state_chunks" USING btree ("project_id","key","head_version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mdx_state_head_project_updated_idx" ON "mdx_state_head" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mdx_state_ws_cursors_updated_at_idx" ON "mdx_state_ws_cursors" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "note_edges_dst_kind_idx" ON "note_edges" USING btree ("dst","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notes_user_updated_idx" ON "notes" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_status_created_idx" ON "notifications" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_dedupe_key_unique" ON "notifications" USING btree ("dedupe_key") WHERE dedupe_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_invites_token_hash_unique" ON "org_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_invites_pending_unique" ON "org_invites" USING btree ("org_id","email","status") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_memberships_user_id_idx" ON "org_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_unique" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organizations_owner_user_id_idx" ON "organizations" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_shares_project_user_unique" ON "project_shares" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_shares_user_id_idx" ON "project_shares" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_announcements_space_pinned_created_idx" ON "space_announcements" USING btree ("space_id","pinned","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_memberships_user_id_idx" ON "space_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spaces_org_id_idx" ON "spaces" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spaces_default_per_org_idx" ON "spaces" USING btree ("org_id","kind") WHERE kind = 'default';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_memberships_user_id_idx" ON "team_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_space_grants_space_id_idx" ON "team_space_grants" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "teams_org_id_name_unique" ON "teams" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_is_master_admin_idx" ON "users" USING btree ("is_master_admin");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_shares_workspace_user_unique" ON "workspace_shares" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_shares_user_id_idx" ON "workspace_shares" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wpn_explorer_state_org_space_project_idx" ON "wpn_explorer_state" USING btree ("org_id","space_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wpn_notes_id_user_unique" ON "wpn_notes" USING btree ("id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wpn_notes_project_parent_sibling_idx" ON "wpn_notes" USING btree ("user_id","project_id","parent_id","sibling_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wpn_notes_org_space_project_idx" ON "wpn_notes" USING btree ("org_id","space_id","project_id","parent_id","sibling_index");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wpn_projects_id_user_unique" ON "wpn_projects" USING btree ("id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wpn_projects_user_workspace_sort_idx" ON "wpn_projects" USING btree ("user_id","workspace_id","sort_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wpn_projects_org_space_workspace_sort_idx" ON "wpn_projects" USING btree ("org_id","space_id","workspace_id","sort_index");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wpn_workspaces_id_user_unique" ON "wpn_workspaces" USING btree ("id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wpn_workspaces_user_sort_idx" ON "wpn_workspaces" USING btree ("user_id","sort_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wpn_workspaces_org_space_sort_idx" ON "wpn_workspaces" USING btree ("org_id","space_id","sort_index");