import type { Context } from "hono";
import type { TrpcContext, JobQueue } from "@orqestra/trpc";
import { db, users, eq } from "@orqestra/db";
import { auth } from "./auth";
import { orchestrators } from "./orchestrator-clients";
import { enqueueModelCreate, enqueueModelReadyCheck } from "./queue";

const queue: JobQueue = {
  enqueueModelCreate,
  enqueueModelReadyCheck,
};

export async function createContext(c: Context): Promise<TrpcContext> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);

  let user = null;
  if (session?.user?.id) {
    const [row] = await db.select().from(users).where(eq(users.id, session.user.id)).limit(1);
    user = row ?? null;
  }

  const ip =
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    null;

  return {
    user,
    sessionId: session?.session?.id ?? null,
    orchestrators,
    queue,
    ip,
  };
}
