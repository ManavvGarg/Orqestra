import { Hono } from "hono";
import { db, jupyterProjects, eq, and } from "@orqestra/db";
import { env } from "@orqestra/env/api";
import { auth } from "../auth";
import { log } from "../log";

const FILE_ROOT = "/home/jovyan";

function sanitizePath(p: string): string | null {
  let normalized = p.trim();
  if (!normalized) normalized = FILE_ROOT;
  if (!normalized.startsWith("/")) normalized = `${FILE_ROOT}/${normalized}`;
  const parts: string[] = [];
  for (const seg of normalized.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const clean = "/" + parts.join("/");
  if (clean !== FILE_ROOT && !clean.startsWith(FILE_ROOT + "/")) return null;
  return clean;
}

export const filesRoutes = new Hono();

filesRoutes.get("/jupyter/:projectId/download", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
  if (!session?.user?.id) return c.json({ error: "unauthorized" }, 401);

  const projectId = c.req.param("projectId");
  const requestedPath = c.req.query("path") ?? FILE_ROOT;
  const safePath = sanitizePath(requestedPath);
  if (!safePath) return c.json({ error: "invalid path" }, 400);

  const [project] = await db
    .select()
    .from(jupyterProjects)
    .where(and(eq(jupyterProjects.id, projectId), eq(jupyterProjects.userId, session.user.id)))
    .limit(1);
  if (!project) return c.json({ error: "not found" }, 404);
  if (!project.containerId) return c.json({ error: "no container" }, 400);
  if (project.status !== "running")
    return c.json({ error: "container not running" }, 400);

  const upstream = await fetch(
    `${env.ORCHESTRATOR_JUPYTER_URL}/internal/jupyter/download`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": env.INTERNAL_API_SECRET,
      },
      body: JSON.stringify({ containerId: project.containerId, path: safePath }),
    },
  ).catch((err) => {
    log.error({ err: err.message }, "orchestrator download fetch failed");
    return null;
  });

  if (!upstream || !upstream.ok || !upstream.body) {
    const text = upstream ? await upstream.text().catch(() => "") : "";
    return c.json({ error: "orchestrator download failed", detail: text }, 502);
  }

  const headers = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  const cd = upstream.headers.get("content-disposition");
  if (cd) headers.set("content-disposition", cd);
  const cl = upstream.headers.get("content-length");
  if (cl) headers.set("content-length", cl);

  return new Response(upstream.body, { status: 200, headers });
});
