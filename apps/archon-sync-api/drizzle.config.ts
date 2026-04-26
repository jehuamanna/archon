import { defineConfig } from "drizzle-kit";

const databaseUrl =
  (typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.trim()) ||
  "postgres://archon:archon@localhost:5432/archon_sync";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
