import IORedis from "ioredis";
import { z } from "zod";
import pino from "pino";
import { db, sessions, users, eq, and } from "@orqestra/db";
import { env } from "@orqestra/env/ws";
import type { ServerWebSocket } from "bun";

const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: true } },
});

const subscribeMsg = z.object({
  type: z.literal("subscribe"),
  projectId: z.string().uuid(),
  sessionId: z.string().min(1),
});
const unsubscribeMsg = z.object({
  type: z.literal("unsubscribe"),
  projectId: z.string().uuid(),
});
const clientMsg = z.discriminatedUnion("type", [subscribeMsg, unsubscribeMsg]);

interface SocketData {
  rooms: Set<string>;
}

const rooms = new Map<string, Set<ServerWebSocket<SocketData>>>();

const subscriber = new IORedis(env.REDIS_URL);
subscriber.psubscribe("container-logs:*", (err) => {
  if (err) log.error({ err }, "psubscribe failed");
  else log.info("subscribed to container-logs:*");
});

subscriber.on("pmessage", (_pattern, channel, message) => {
  const projectId = channel.replace("container-logs:", "");
  const sockets = rooms.get(projectId);
  if (!sockets || sockets.size === 0) return;

  if (message === "__BUILD_COMPLETE__" || message === "__BUILD_FAILED__") {
    const payload = JSON.stringify({
      type: "done",
      projectId,
      ok: message === "__BUILD_COMPLETE__",
    });
    for (const ws of sockets) ws.send(payload);
    return;
  }

  const payload = JSON.stringify({ type: "log", projectId, line: message, ts: Date.now() });
  for (const ws of sockets) ws.send(payload);
});

async function validateSession(sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: sessions.userId, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sessionId)))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return row.userId;
}

function joinRoom(ws: ServerWebSocket<SocketData>, projectId: string) {
  let set = rooms.get(projectId);
  if (!set) {
    set = new Set();
    rooms.set(projectId, set);
  }
  set.add(ws);
  ws.data.rooms.add(projectId);
}

function leaveRoom(ws: ServerWebSocket<SocketData>, projectId: string) {
  const set = rooms.get(projectId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) rooms.delete(projectId);
  }
  ws.data.rooms.delete(projectId);
}

const server = Bun.serve<SocketData, undefined>({
  port: env.PORT,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/ws") {
      const ok = srv.upgrade(req, { data: { rooms: new Set<string>() } });
      if (ok) return undefined;
      return new Response("Upgrade failed", { status: 400 });
    }
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      log.debug("ws open");
    },
    async message(ws, raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "invalid json" }));
        return;
      }
      const result = clientMsg.safeParse(parsed);
      if (!result.success) {
        ws.send(JSON.stringify({ type: "error", message: "invalid message" }));
        return;
      }
      const msg = result.data;

      if (msg.type === "subscribe") {
        const userId = await validateSession(msg.sessionId);
        if (!userId) {
          ws.send(
            JSON.stringify({ type: "error", projectId: msg.projectId, message: "unauthorized" }),
          );
          return;
        }
        joinRoom(ws, msg.projectId);
        ws.send(JSON.stringify({ type: "subscribed", projectId: msg.projectId }));
        return;
      }

      if (msg.type === "unsubscribe") {
        leaveRoom(ws, msg.projectId);
        ws.send(JSON.stringify({ type: "unsubscribed", projectId: msg.projectId }));
      }
    },
    close(ws) {
      for (const projectId of ws.data.rooms) leaveRoom(ws, projectId);
    },
  },
});

log.info({ port: server.port }, "ws listening");
