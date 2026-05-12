import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  and,
  asc,
  db,
  desc,
  eq,
  inArray,
  jupyterProjectTags,
  jupyterProjects,
  modelProjectTags,
  modelProjects,
  models,
  projectTags,
  sandboxProjectTags,
  sandboxProjects,
  swarmTags,
  swarms,
} from "@orqestra/db";
import { router, protectedProcedure } from "../trpc";

type ProjectTagDto = { id: string; name: string; color: string };
type ProjectTagRow = ProjectTagDto & { projectId: string };

function collectTags(rows: ProjectTagRow[]) {
  const byProject = new Map<string, ProjectTagDto[]>();
  for (const row of rows) {
    const arr = byProject.get(row.projectId) ?? [];
    arr.push({ id: row.id, name: row.name, color: row.color });
    byProject.set(row.projectId, arr);
  }
  return byProject;
}

async function listJupyterTags(projectIds: string[], userId: string) {
  if (projectIds.length === 0) return new Map<string, ProjectTagDto[]>();
  const rows = await db
    .select({
      projectId: jupyterProjectTags.projectId,
      id: projectTags.id,
      name: projectTags.name,
      color: projectTags.color,
    })
    .from(jupyterProjectTags)
    .innerJoin(projectTags, eq(jupyterProjectTags.tagId, projectTags.id))
    .where(and(inArray(jupyterProjectTags.projectId, projectIds), eq(projectTags.userId, userId)))
    .orderBy(asc(projectTags.name));
  return collectTags(rows);
}

async function listModelTags(projectIds: string[], userId: string) {
  if (projectIds.length === 0) return new Map<string, ProjectTagDto[]>();
  const rows = await db
    .select({
      projectId: modelProjectTags.projectId,
      id: projectTags.id,
      name: projectTags.name,
      color: projectTags.color,
    })
    .from(modelProjectTags)
    .innerJoin(projectTags, eq(modelProjectTags.tagId, projectTags.id))
    .where(and(inArray(modelProjectTags.projectId, projectIds), eq(projectTags.userId, userId)))
    .orderBy(asc(projectTags.name));
  return collectTags(rows);
}

async function listSandboxTags(projectIds: string[], userId: string) {
  if (projectIds.length === 0) return new Map<string, ProjectTagDto[]>();
  const rows = await db
    .select({
      projectId: sandboxProjectTags.projectId,
      id: projectTags.id,
      name: projectTags.name,
      color: projectTags.color,
    })
    .from(sandboxProjectTags)
    .innerJoin(projectTags, eq(sandboxProjectTags.tagId, projectTags.id))
    .where(and(inArray(sandboxProjectTags.projectId, projectIds), eq(projectTags.userId, userId)))
    .orderBy(asc(projectTags.name));
  return collectTags(rows);
}

async function listSwarmTags(projectIds: string[], userId: string) {
  if (projectIds.length === 0) return new Map<string, ProjectTagDto[]>();
  const rows = await db
    .select({
      projectId: swarmTags.projectId,
      id: projectTags.id,
      name: projectTags.name,
      color: projectTags.color,
    })
    .from(swarmTags)
    .innerJoin(projectTags, eq(swarmTags.tagId, projectTags.id))
    .where(and(inArray(swarmTags.projectId, projectIds), eq(projectTags.userId, userId)))
    .orderBy(asc(projectTags.name));
  return collectTags(rows);
}

export const projectsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const [jupyter, modelRows, sandboxRows, swarmRows] = await Promise.all([
      db
        .select()
        .from(jupyterProjects)
        .where(eq(jupyterProjects.userId, ctx.user.id))
        .orderBy(desc(jupyterProjects.createdAt)),
      db
        .select()
        .from(modelProjects)
        .where(eq(modelProjects.userId, ctx.user.id))
        .orderBy(desc(modelProjects.createdAt)),
      db
        .select()
        .from(sandboxProjects)
        .where(eq(sandboxProjects.userId, ctx.user.id))
        .orderBy(desc(sandboxProjects.createdAt)),
      db
        .select()
        .from(swarms)
        .where(eq(swarms.userId, ctx.user.id))
        .orderBy(desc(swarms.createdAt)),
    ]);
    const [jupyterTags, modelTags, sandboxTags, swarmTagsMap] = await Promise.all([
      listJupyterTags(jupyter.map((p) => p.id), ctx.user.id),
      listModelTags(modelRows.map((p) => p.id), ctx.user.id),
      listSandboxTags(sandboxRows.map((p) => p.id), ctx.user.id),
      listSwarmTags(swarmRows.map((p) => p.id), ctx.user.id),
    ]);
    return {
      jupyter: jupyter.map((p) => ({
        ...p,
        kind: "jupyter" as const,
        tags: jupyterTags.get(p.id) ?? [],
      })),
      model: modelRows.map((p) => ({
        ...p,
        kind: "model" as const,
        tags: modelTags.get(p.id) ?? [],
      })),
      sandbox: sandboxRows.map((p) => ({
        ...p,
        kind: "sandbox" as const,
        tags: sandboxTags.get(p.id) ?? [],
      })),
      swarm: swarmRows.map((p) => ({
        ...p,
        kind: "swarm" as const,
        tags: swarmTagsMap.get(p.id) ?? [],
      })),
    };
  }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid(), kind: z.enum(["jupyter", "model", "sandbox", "swarm"]) }))
    .query(async ({ ctx, input }) => {
      if (input.kind === "jupyter") {
        const [row] = await db
          .select()
          .from(jupyterProjects)
          .where(and(eq(jupyterProjects.id, input.id), eq(jupyterProjects.userId, ctx.user.id)))
          .limit(1);
        if (!row) throw new TRPCError({ code: "NOT_FOUND" });
        const tags = await listJupyterTags([row.id], ctx.user.id);
        return { ...row, kind: "jupyter" as const, tags: tags.get(row.id) ?? [] };
      }
      if (input.kind === "sandbox") {
        const [row] = await db
          .select()
          .from(sandboxProjects)
          .where(and(eq(sandboxProjects.id, input.id), eq(sandboxProjects.userId, ctx.user.id)))
          .limit(1);
        if (!row) throw new TRPCError({ code: "NOT_FOUND" });
        const tags = await listSandboxTags([row.id], ctx.user.id);
        return { ...row, kind: "sandbox" as const, tags: tags.get(row.id) ?? [] };
      }
      if (input.kind === "swarm") {
        const [row] = await db
          .select()
          .from(swarms)
          .where(and(eq(swarms.id, input.id), eq(swarms.userId, ctx.user.id)))
          .limit(1);
        if (!row) throw new TRPCError({ code: "NOT_FOUND" });
        const tags = await listSwarmTags([row.id], ctx.user.id);
        return { ...row, kind: "swarm" as const, tags: tags.get(row.id) ?? [] };
      }
      const [row] = await db
        .select()
        .from(modelProjects)
        .where(and(eq(modelProjects.id, input.id), eq(modelProjects.userId, ctx.user.id)))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      const tags = await listModelTags([row.id], ctx.user.id);
      let model: typeof models.$inferSelect | null = null;
      if (row.modelId) {
        const [m] = await db.select().from(models).where(eq(models.id, row.modelId)).limit(1);
        model = m ?? null;
      }
      return { ...row, kind: "model" as const, model, tags: tags.get(row.id) ?? [] };
    }),
});
