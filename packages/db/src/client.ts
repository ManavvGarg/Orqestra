import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { loadRootEnv } from "./load-root-env";

loadRootEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL not set");
}

const queryClient = postgres(databaseUrl, {
  max: 10,
  prepare: false,
});

export const db = drizzle(queryClient, { schema });
export type Database = typeof db;
