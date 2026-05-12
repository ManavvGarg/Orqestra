import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  and,
  asc,
  db,
  eq,
  jupyterProjectTags,
  jupyterProjects,
  modelProjectTags,
  modelProjects,
  projectTags,
  sandboxProjectTags,
  sandboxProjects,
  swarmTags,
  swarms,
} from "@orqestra/db";
import { protectedProcedure, router } from "../trpc";

const tagNameSchema = z.string().trim().min(1).max(40);
const tagColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/)
  .default("#6366f1");
const projectKindSchema = z.enum(["jupyter", "model", "sandbox", "swarm"]);
type ProjectKind = z.infer<typeof projectKindSchema>;

async function getOwnedTag(userId: string, tagId: string) {
  const [tag] = await db
    .select()
    .from(projectTags)
    .where(and(eq(projectTags.id, tagId), eq(projectTags.userId, userId)))
    .limit(1);
  return tag;
}

async function ensureOwnedProject(userId: string, kind: ProjectKind, projectId: string) {
  let project: { id: string } | undefined;
  if (kind === "jupyter") {
    [project] = await db
      .select({ id: jupyterProjects.id })
      .from(jupyterProjects)
      .where(and(eq(jupyterProjects.id, projectId), eq(jupyterProjects.userId, userId)))
      .limit(1);
  } else if (kind === "sandbox") {
    [project] = await db
      .select({ id: sandboxProjects.id })
      .from(sandboxProjects)
      .where(and(eq(sandboxProjects.id, projectId), eq(sandboxProjects.userId, userId)))
      .limit(1);
  } else if (kind === "swarm") {
    [project] = await db
      .select({ id: swarms.id })
      .from(swarms)
      .where(and(eq(swarms.id, projectId), eq(swarms.userId, userId)))
      .limit(1);
  } else {
    [project] = await db
      .select({ id: modelProjects.id })
      .from(modelProjects)
      .where(and(eq(modelProjects.id, projectId), eq(modelProjects.userId, userId)))
      .limit(1);
  }
  if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
}

export const tagsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return db
      .select()
      .from(projectTags)
      .where(eq(projectTags.userId, ctx.user.id))
      .orderBy(asc(projectTags.name));
  }),

  create: protectedProcedure
    .input(z.object({ name: tagNameSchema, color: tagColorSchema.optional() }))
    .mutation(async ({ ctx, input }) => {
      const [existing] = await db
        .select({ id: projectTags.id })
        .from(projectTags)
        .where(and(eq(projectTags.userId, ctx.user.id), eq(projectTags.name, input.name)))
        .limit(1);
      if (existing) throw new TRPCError({ code: "CONFLICT", message: "Tag already exists" });

      const [created] = await db
        .insert(projectTags)
        .values({
          userId: ctx.user.id,
          name: input.name,
          color: input.color ?? "#6366f1",
        })
        .returning();
      if (!created) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return created;
    }),

  update: protectedProcedure
    .input(
      z.object({
        tagId: z.string().uuid(),
        name: tagNameSchema,
        color: tagColorSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tag = await getOwnedTag(ctx.user.id, input.tagId);
      if (!tag) throw new TRPCError({ code: "NOT_FOUND", message: "Tag not found" });

      const [existing] = await db
        .select({ id: projectTags.id })
        .from(projectTags)
        .where(and(eq(projectTags.userId, ctx.user.id), eq(projectTags.name, input.name)))
        .limit(1);
      if (existing && existing.id !== input.tagId) {
        throw new TRPCError({ code: "CONFLICT", message: "Tag already exists" });
      }

      const [updated] = await db
        .update(projectTags)
        .set({ name: input.name, color: input.color, updatedAt: new Date() })
        .where(eq(projectTags.id, input.tagId))
        .returning();
      if (!updated) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return updated;
    }),

  remove: protectedProcedure
    .input(z.object({ tagId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const tag = await getOwnedTag(ctx.user.id, input.tagId);
      if (!tag) throw new TRPCError({ code: "NOT_FOUND", message: "Tag not found" });
      await db.delete(projectTags).where(eq(projectTags.id, input.tagId));
      return { ok: true as const };
    }),

  assign: protectedProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        projectKind: projectKindSchema,
        tagId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tag = await getOwnedTag(ctx.user.id, input.tagId);
      if (!tag) throw new TRPCError({ code: "NOT_FOUND", message: "Tag not found" });
      await ensureOwnedProject(ctx.user.id, input.projectKind, input.projectId);

      if (input.projectKind === "jupyter") {
        await db
          .insert(jupyterProjectTags)
          .values({ projectId: input.projectId, tagId: input.tagId })
          .onConflictDoNothing();
      } else if (input.projectKind === "sandbox") {
        await db
          .insert(sandboxProjectTags)
          .values({ projectId: input.projectId, tagId: input.tagId })
          .onConflictDoNothing();
      } else if (input.projectKind === "swarm") {
        await db
          .insert(swarmTags)
          .values({ projectId: input.projectId, tagId: input.tagId })
          .onConflictDoNothing();
      } else {
        await db
          .insert(modelProjectTags)
          .values({ projectId: input.projectId, tagId: input.tagId })
          .onConflictDoNothing();
      }
      return { ok: true as const };
    }),

  unassign: protectedProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        projectKind: projectKindSchema,
        tagId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tag = await getOwnedTag(ctx.user.id, input.tagId);
      if (!tag) throw new TRPCError({ code: "NOT_FOUND", message: "Tag not found" });
      await ensureOwnedProject(ctx.user.id, input.projectKind, input.projectId);

      if (input.projectKind === "jupyter") {
        await db
          .delete(jupyterProjectTags)
          .where(
            and(
              eq(jupyterProjectTags.projectId, input.projectId),
              eq(jupyterProjectTags.tagId, input.tagId),
            ),
          );
      } else if (input.projectKind === "sandbox") {
        await db
          .delete(sandboxProjectTags)
          .where(
            and(
              eq(sandboxProjectTags.projectId, input.projectId),
              eq(sandboxProjectTags.tagId, input.tagId),
            ),
          );
      } else if (input.projectKind === "swarm") {
        await db
          .delete(swarmTags)
          .where(
            and(
              eq(swarmTags.projectId, input.projectId),
              eq(swarmTags.tagId, input.tagId),
            ),
          );
      } else {
        await db
          .delete(modelProjectTags)
          .where(
            and(
              eq(modelProjectTags.projectId, input.projectId),
              eq(modelProjectTags.tagId, input.tagId),
            ),
          );
      }
      return { ok: true as const };
    }),
});
