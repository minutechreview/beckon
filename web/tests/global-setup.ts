import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const ADMIN = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://beckon:beckon@localhost:5432/postgres";
const TEST = process.env.TEST_DATABASE_URL ?? "postgres://beckon:beckon@localhost:5432/beckon_test";

export default async function setup() {
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  const name = new URL(TEST).pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`bad database name: ${name}`);
  const { rowCount } = await admin.query("select 1 from pg_database where datname = $1", [name]);
  if (!rowCount) await admin.query(`create database ${name}`);
  await admin.end();

  const pool = new pg.Pool({ connectionString: TEST });
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  await pool.end();
}
