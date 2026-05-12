import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { trpcServer } from "@hono/trpc-server";
import { rateLimiter } from "hono-rate-limiter";
import { appRouter } from "@orqestra/trpc";
import { env } from "@orqestra/env/api";
import { auth } from "./auth";
import { createContext } from "./context";
import {
  startCatalogWorker,
  ensureCatalogSchedule,
  startModelCreateWorker,
  startModelReadyWorker,
  startAgenthiveRunWorker,
} from "./queue";
import { filesRoutes } from "./routes/files";
import { agenthiveInternalRoutes } from "./routes/agenthive-internal";
import { log } from "./log";

const app = new Hono();

app.use("*", honoLogger((msg) => log.info(msg)));

app.use(
  "*",
  cors({
    origin: [
      `https://${env.SITE_DOMAIN}`,
      `https://www.${env.SITE_DOMAIN}`,
      "http://localhost:3000",
    ],
    credentials: true,
  }),
);

app.use(
  "*",
  rateLimiter({
    windowMs: 5 * 60 * 1000,
    limit: 100,
    standardHeaders: "draft-6",
    keyGenerator: (c) =>
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      "anon",
  }),
);

app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.route("/files", filesRoutes);
app.route("/internal/agenthive", agenthiveInternalRoutes);

app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    createContext: (_opts, c) => createContext(c),
    endpoint: "/trpc",
  }),
);

const catalogWorker = startCatalogWorker();
const modelCreateWorker = startModelCreateWorker();
const modelReadyWorker = startModelReadyWorker();
const agenthiveRunWorker = startAgenthiveRunWorker();
ensureCatalogSchedule().catch((err) =>
  log.error({ err: err instanceof Error ? err.message : err }, "catalog schedule failed"),
);

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  await Promise.all([
    catalogWorker.close(),
    modelCreateWorker.close(),
    modelReadyWorker.close(),
    agenthiveRunWorker.close(),
  ]);
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log.info({ port: env.PORT }, "api listening");

export default {
  port: env.PORT,
  idleTimeout: 60, // seconds; default 10 too short for catalog calls
  fetch: app.fetch,
};
