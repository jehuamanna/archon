import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const uri = process.env.MONGODB_URI?.trim() || "mongodb://127.0.0.1:27017";
const dryRun = process.argv.includes("--dry-run");
const TEST_DB_REGEX = /_it_[a-f0-9]{16}$/;

const client = new MongoClient(uri);
await client.connect();
try {
  const dbs = await client.db().admin().listDatabases();
  const matches = dbs.databases
    .filter((d) => TEST_DB_REGEX.test(d.name))
    .map((d) => d.name);
  console.log(`Found ${matches.length} integration-test DBs (pattern: ${TEST_DB_REGEX})`);
  for (const n of matches.slice(0, 12)) console.log("  " + n);
  if (matches.length > 12) console.log(`  ... and ${matches.length - 12} more`);
  if (dryRun) {
    console.log("--dry-run: not dropping");
  } else {
    let dropped = 0;
    for (const n of matches) {
      await client.db(n).dropDatabase();
      dropped++;
    }
    console.log(`Dropped ${dropped} DBs`);
  }
} finally {
  await client.close();
}
