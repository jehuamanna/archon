import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root `/.env` for one-file config (Compose also reads this path). Does not override existing process.env. */
const rootEnv = path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  ".env",
);
dotenv.config({ path: rootEnv });
