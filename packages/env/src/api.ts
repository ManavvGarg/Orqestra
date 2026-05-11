import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { loadRootEnv } from "./load-root-env";

loadRootEnv();

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.string().url().optional(),
    INTERNAL_API_SECRET: z.string().min(32),
    ORCHESTRATOR_JUPYTER_URL: z.string().url(),
    ORCHESTRATOR_HOSTING_URL: z.string().url(),
    ORCHESTRATOR_SANDBOX_URL: z.string().url(),
    SITE_DOMAIN: z.string().min(1),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
