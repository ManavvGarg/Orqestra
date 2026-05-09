import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { db, jupyterProjects, eq, and } from "@orqestra/db";
import { router, protectedProcedure } from "../trpc";
import { buildSlug } from "../util/slug";

const jobTypeSchema = z.enum(["base", "tensorflow", "pytorch", "r"]);

const gpuChoiceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }),
  z.object({ mode: z.literal("auto") }),
  z.object({
    mode: z.literal("specific"),
    gpuIndex: z.number().int().nonnegative(),
    vramLimitMB: z.number().int().positive().optional(),
  }),
]);

export const jupyterRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80),
        jobType: jobTypeSchema,
        description: z.string().max(500).optional(),
        cpuLimit: z.string().optional(),
        memoryLimit: z.string().optional(),
        gpu: gpuChoiceSchema.default({ mode: "off" }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const slug = buildSlug(input.name);
      const volumeName = `orqestra_${ctx.user.id.replace(/-/g, "")}_${slug}`;

      // Resolve GPU choice via host capabilities.
      let gpuIndex: number | null = null;
      let vramLimitMB: number | null = null;
      if (input.gpu.mode !== "off") {
        const cap = await ctx.orchestrators.hosting.capabilities();
        if (input.gpu.mode === "auto" && cap.hasGPU && cap.gpus[0]) {
          gpuIndex = cap.gpus[0].index;
          vramLimitMB = 2 * 1024;
        } else if (input.gpu.mode === "specific") {

  const { gpuIndex: requestedGpuIndex } = input.gpu;

  const g = cap.gpus.find((x) => x.index === requestedGpuIndex);

  if (!g) {

    throw new TRPCError({

      code: "BAD_REQUEST",

      message: `GPU ${requestedGpuIndex} not found`,

    });

  }
          gpuIndex = g.index;
          vramLimitMB = input.gpu.vramLimitMB ?? 2 * 1024;
        }
      }

      const [created] = await db
        .insert(jupyterProjects)
        .values({
          userId: ctx.user.id,
          name: input.name,
          slug,
          jobType: input.jobType,
          description: input.description,
          volumeName,
          cpuLimit: input.cpuLimit,
          memoryLimit: input.memoryLimit,
          gpuIndex: gpuIndex ?? undefined,
          vramLimitMB: vramLimitMB ?? undefined,
          status: "creating",
        })
        .returning();

      if (!created) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      try {
        const result = await ctx.orchestrators.jupyter.create({
          projectId: created.id,
          slug: created.slug,
          userId: ctx.user.id,
          jobType: input.jobType,
          volumeName,
          cpuLimit: input.cpuLimit,
          memoryLimit: input.memoryLimit,
          gpuIndex,
          vramLimitMB,
        });

        const [updated] = await db
          .update(jupyterProjects)
          .set({
            containerId: result.containerId,
            containerUrl: result.containerUrl,
            containerToken: result.containerToken,
            containerPort: result.containerPort,
            status: "running",
            updatedAt: new Date(),
          })
          .where(eq(jupyterProjects.id, created.id))
          .returning();

        return updated!;
      } catch (err) {
        await db
          .update(jupyterProjects)
          .set({ status: "errored", updatedAt: new Date() })
          .where(eq(jupyterProjects.id, created.id));
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error ? err.message : "Orchestrator failed",
        });
      }
    }),

  stats: protectedProcedure
    .input(z.object({ projectId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [project] = await db
        .select()
        .from(jupyterProjects)
        .where(
          and(eq(jupyterProjects.id, input.projectId), eq(jupyterProjects.userId, ctx.user.id)),
        )
        .limit(1);
      if (!project) throw new TRPCError({ code: "NOT_FOUND" });
      if (!project.containerId) throw new TRPCError({ code: "BAD_REQUEST", message: "No container" });
      if (project.status !== "running") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Container is not running" });
      }

      return ctx.orchestrators.jupyter.stats({ containerId: project.containerId });
    }),

  start: protectedProcedure
    .input(z.object({ projectId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [project] = await db
        .select()
        .from(jupyterProjects)
        .where(
          and(eq(jupyterProjects.id, input.projectId), eq(jupyterProjects.userId, ctx.user.id)),
        )
        .limit(1);
      if (!project) throw new TRPCError({ code: "NOT_FOUND" });
      if (!project.containerId) throw new TRPCError({ code: "BAD_REQUEST", message: "No container" });

      const result = await ctx.orchestrators.jupyter.start({ containerId: project.containerId });

      const [updated] = await db
        .update(jupyterProjects)
        .set({
          status: "running",
          containerUrl: result.containerUrl ?? project.containerUrl,
          containerPort: result.containerPort ?? project.containerPort,
          updatedAt: new Date(),
        })
        .where(eq(jupyterProjects.id, project.id))
        .returning();

      return updated!;
    }),

  stop: protectedProcedure
    .input(z.object({ projectId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [project] = await db
        .select()
        .from(jupyterProjects)
        .where(
          and(eq(jupyterProjects.id, input.projectId), eq(jupyterProjects.userId, ctx.user.id)),
        )
        .limit(1);
      if (!project) throw new TRPCError({ code: "NOT_FOUND" });
      if (!project.containerId) throw new TRPCError({ code: "BAD_REQUEST", message: "No container" });

      await ctx.orchestrators.jupyter.stop({ containerId: project.containerId });

      await db
        .update(jupyterProjects)
        .set({ status: "stopped", updatedAt: new Date() })
        .where(eq(jupyterProjects.id, project.id));

      return { ok: true as const };
    }),

  destroy: protectedProcedure
    .input(z.object({ projectId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [project] = await db
        .select()
        .from(jupyterProjects)
        .where(
          and(eq(jupyterProjects.id, input.projectId), eq(jupyterProjects.userId, ctx.user.id)),
        )
        .limit(1);
      if (!project) throw new TRPCError({ code: "NOT_FOUND" });

      if (project.containerId) {
        await ctx.orchestrators.jupyter.destroy({
          containerId: project.containerId,
          volumeName: project.volumeName,
        });
      }

      await db
        .update(jupyterProjects)
        .set({
          status: "destroyed",
          containerId: null,
          containerUrl: null,
          containerToken: null,
          containerPort: null,
          updatedAt: new Date(),
        })
        .where(eq(jupyterProjects.id, project.id));

      return { ok: true as const };
    }),
});
