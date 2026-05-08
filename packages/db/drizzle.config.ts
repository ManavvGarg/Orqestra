import type { Config } from "drizzle-kit";
import { loadRootEnv } from "./src/load-root-env";

loadRootEnv();

export default {
  schema: "./src/schema.ts",
  out: "./src/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DRIZZLE_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "postgresql://orqestra:changeme@localhost:5432/orqestra",
  },
  strict: true,
  verbose: true,
} satisfies Config;
