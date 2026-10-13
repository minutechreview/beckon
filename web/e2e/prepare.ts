import { execFileSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { E2E_DB, E2E_DB_NAME } from "./paths";

const ADMIN = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://beckon:beckon@localhost:5432/postgres";

async function main() {
  // Fresh database per run so the test starts with no users or hosts.
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  if (!/^[a-z0-9_]+$/.test(E2E_DB_NAME)) throw new Error(`bad database name: ${E2E_DB_NAME}`);
  await admin.query(`drop database if exists ${E2E_DB_NAME} with (force)`);
  await admin.query(`create database ${E2E_DB_NAME}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: E2E_DB });
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  await pool.end();

  // The test drives the real helper binary.
  execFileSync("go", ["build", "-o", "bin/beckon", "./cmd/beckon"], {
    cwd: path.resolve(import.meta.dirname, "../../helper"),
    stdio: "inherit",
  });
}

await main();
