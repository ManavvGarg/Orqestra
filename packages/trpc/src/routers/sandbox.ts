import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { db, sandboxProjects, eq, and } from "@orqestra/db";
import { router, protectedProcedure } from "../trpc";
import { buildSlug } from "../util/slug";

const distroSchema = z.enum(["ubuntu-22.04", "ubuntu-24.04", "debian-12", "alpine-3.20"]);

const gpuChoiceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }),
  z.object({ mode: z.literal("auto") }),
  z.object({
    mode: z.literal("specific"),
    gpuIndex: z.number().int().nonnegative(),
    vramLimitMB: z.number().int().positive().optional(),
  }),
]);

export const sandboxRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80),
        distro: distroSchema,
        description: z.string().max(500).optional(),
        cpuLimit: z.string().optional(),
        memoryLimit: z.string().optional(),
        gpu: gpuChoiceSchema.default({ mode: "off" }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const slug = buildSlug(input.name);
      const volumeName = `orqestra_sandbox_${ctx.user.id.replace(/-/g, "")}_${slug}`;

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
        .insert(sandboxProjects)
        .values({
          userId: ctx.user.id,
          name: input.name,
          slug,
          distro: input.distro,
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
        const result = await ctx.orchestrators.sandbox.create({
          projectId: created.id,
          slug: created.slug,
          userId: ctx.user.id,
          distro: input.distro,
          volumeName,
          cpuLimit: input.cpuLimit,
          memoryLimit: input.memoryLimit,
          gpuIndex,
          vramLimitMB,
        });

        const [updated] = await db
          .update(sandboxProjects)
          .set({
            containerId: result.containerId,
            containerPort: result.containerPort,
            sshHost: result.sshHost,
            sshUser: result.sshUser,
            publicKey: result.publicKey,
            status: "running",
            updatedAt: new Date(),
          })
          .where(eq(sandboxProjects.id, created.id))
          .returning();

        // Private key is one-shot — returned to caller, never stored.
        return {
          project: updated!,
          privateKey: result.privateKey,
          sshCommand: result.sshCommand,
        };
      } catch (err) {
        await db
          .update(sandboxProjects)
          .set({ status: "errored", updatedAt: new Date() })
          .where(eq(sandboxProjects.id, created.id));
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
        .from(sandboxProjects)
        .where(
          and(eq(sandboxProjects.id, input.projectId), eq(sandboxProjects.userId, ctx.user.id)),
        )
        .limit(1);
      if (!project) throw new TRPCError({ code: "NOT_FOUND" });
      if (!project.containerId) throw new TRPCError({ code: "BAD_REQUEST", message: "No container" });
      if (project.status !== "running") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Container is not running" });
      }
      return ctx.orchestrators.sandbox.stats({ containerId: project.containerId });
    }),

  start: protectedProcedure
    .input(z.object({ projectId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [project] = await db
        .select()
        .from(sandboxProjects)
        .where(
          and(eq(sandboxProjects.id, input.projectId), eq(sandboxProjects.userId, ctx.user.id)),
        )
        .limit(1);
      if (!project) throw new TRPCError({ code: "NOT_FOUND" });
      if (!project.containerId) throw new TRPCError({ code: "BAD_REQUEST", message: "No container" });

      const result = await ctx.orchestrators.sandbox.start({ containerId: project.containerId });

      const [updated] = await db
        .update(sandboxProjects)
        .set({
          status: "running",
          containerPort: result.containerPort ?? project.containerPort,
          updatedAt: new Date(),
        })
        .where(eq(sandboxProjects.id, project.id))
        .returning();

      return { project: updated!, sshCommand: result.sshCommand };
    }),

  stop: protectedProcedure
    .input(z.object({ projectId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [project] = await db
        .select()
        .from(sandboxProjects)
        .where(
          and(eq(sandboxProjects.id, input.projectId), eq(sandboxProjects.userId, ctx.user.id)),
        )
        .limit(1);
      if (!project) throw new TRPCError({ code: "NOT_FOUND" });
      if (!project.containerId) throw new TRPCError({ code: "BAD_REQUEST", message: "No container" });

      await ctx.orchestrators.sandbox.stop({ containerId: project.containerId });

      await db
        .update(sandboxProjects)
        .set({ status: "stopped", updatedAt: new Date() })
        .where(eq(sandboxProjects.id, project.id));

      return { ok: true as const };
    }),

  destroy: protectedProcedure
    .input(z.object({ projectId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [project] = await db
        .select()
        .from(sandboxProjects)
        .where(
          and(eq(sandboxProjects.id, input.projectId), eq(sandboxProjects.userId, ctx.user.id)),
        )
        .limit(1);
      if (!project) throw new TRPCError({ code: "NOT_FOUND" });

      if (project.containerId) {
        await ctx.orchestrators.sandbox.destroy({
          containerId: project.containerId,
          volumeName: project.volumeName,
        });
      }

      await db
        .update(sandboxProjects)
        .set({
          status: "destroyed",
          containerId: null,
          containerPort: null,
          publicKey: null,
          updatedAt: new Date(),
        })
        .where(eq(sandboxProjects.id, project.id));

      return { ok: true as const };
    }),
});
