import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { db, jupyterProjects, eq, and } from "@orqestra/db";
import { router, protectedProcedure } from "../trpc";

const FILE_ROOT = "/home/jovyan";

function sanitizePath(p: string): string {
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
  if (clean !== FILE_ROOT && !clean.startsWith(FILE_ROOT + "/")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "path outside allowed root" });
  }
  return clean;
}

export const filesRouter = router({
  list: protectedProcedure
    .input(z.object({ projectId: z.string().uuid(), path: z.string().default(FILE_ROOT) }))
    .query(async ({ ctx, input }) => {
      const [project] = await db
        .select()
        .from(jupyterProjects)
        .where(
          and(eq(jupyterProjects.id, input.projectId), eq(jupyterProjects.userId, ctx.user.id)),
        )
        .limit(1);
      if (!project) throw new TRPCError({ code: "NOT_FOUND" });
      if (!project.containerId) throw new TRPCError({ code: "BAD_REQUEST", message: "no container" });
      if (project.status !== "running")
        throw new TRPCError({ code: "BAD_REQUEST", message: "container not running" });

      const safePath = sanitizePath(input.path);
      const result = await ctx.orchestrators.jupyter.list({
        containerId: project.containerId,
        path: safePath,
      });
      return result;
    }),
});

export { sanitizePath, FILE_ROOT };
