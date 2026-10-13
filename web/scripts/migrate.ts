import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "../src/db";

await migrate(db(), { migrationsFolder: "./drizzle" });
await pool().end();
console.log("migrations applied");
