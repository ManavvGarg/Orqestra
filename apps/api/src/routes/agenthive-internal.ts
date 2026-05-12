import { Hono } from "hono";
import {
  db,
  swarmMessages,
  swarmThreads,
  eq,
  type SwarmMessageContent,
  type SwarmToolCall,
} from "@orqestra/db";
import { env } from "@orqestra/env/api";
import { log } from "../log";

export const agenthiveInternalRoutes = new Hono();

agenthiveInternalRoutes.use("*", async (c, next) => {
  const got = c.req.header("X-Internal-Secret") ?? "";
  if (got.length !== env.INTERNAL_API_SECRET.length) {
    return c.json({ error: "unauthorized" }, 401);
  }
  // constant-time-ish comparison
  let diff = 0;
  for (let i = 0; i < got.length; i++) {
    diff |= got.charCodeAt(i) ^ env.INTERNAL_API_SECRET.charCodeAt(i);
  }
  if (diff !== 0) return c.json({ error: "unauthorized" }, 401);
  await next();
});

interface ThreadAppendBody {
  threadId: string;
  sender: string | null;
  receiver: string | null;
  role: "user" | "assistant" | "tool" | "system";
  content: SwarmMessageContent;
  toolCalls?: SwarmToolCall[];
}

agenthiveInternalRoutes.post("/thread-append", async (c) => {
  let body: ThreadAppendBody;
  try {
    body = await c.req.json<ThreadAppendBody>();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  if (!body.threadId || !body.role || !body.content) {
    return c.json({ error: "missing fields" }, 400);
  }
  const [thread] = await db
    .select({ id: swarmThreads.id })
    .from(swarmThreads)
    .where(eq(swarmThreads.id, body.threadId))
    .limit(1);
  if (!thread) return c.json({ error: "thread not found" }, 404);

  const [inserted] = await db
    .insert(swarmMessages)
    .values({
      threadId: body.threadId,
      sender: body.sender,
      receiver: body.receiver,
      role: body.role,
      content: body.content,
      toolCalls: body.toolCalls,
    })
    .returning({ id: swarmMessages.id });

  // Bump thread updatedAt so listThreads ordering reflects recent activity.
  await db
    .update(swarmThreads)
    .set({ updatedAt: new Date() })
    .where(eq(swarmThreads.id, body.threadId));

  return c.json({ ok: true, id: inserted?.id });
});

agenthiveInternalRoutes.onError((err, c) => {
  log.error({ err: err instanceof Error ? err.message : err }, "agenthive-internal error");
  return c.json({ error: err instanceof Error ? err.message : "internal error" }, 500);
});
