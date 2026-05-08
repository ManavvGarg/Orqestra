import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { loadRootEnv } from "./load-root-env";

loadRootEnv();

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4001),
    REDIS_URL: z.string().url(),
    DATABASE_URL: z.string().url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    SITE_DOMAIN: z.string().min(1),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
