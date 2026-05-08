import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@orqestra/db";
import * as schema from "@orqestra/db/schema";
import { env } from "@orqestra/env/api";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
    usePlural: true,
  }),
  secret: env.BETTER_AUTH_SECRET,
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    minPasswordLength: 8,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 60 * 5 },
  },
  advanced: {
    database: {
      generateId: () => crypto.randomUUID(),
    },
  },
  trustedOrigins: [
    `https://${env.SITE_DOMAIN}`,
    `https://www.${env.SITE_DOMAIN}`,
    `https://api.${env.SITE_DOMAIN}`,
    "http://localhost:3000",
  ],
});

export type Auth = typeof auth;
