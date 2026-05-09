import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  db,
  models,
  modelProjects,
  modelProjectTags,
  projectTags,
  eq,
  and,
  desc,
  inArray,
} from "@orqestra/db";
import { router, protectedProcedure, publicProcedure } from "../trpc";
import { buildSlug } from "../util/slug";

const runtimeSchema = z.enum(["ollama", "docker-model-runner", "llama-cpp"]);

const gpuChoiceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }),
  z.object({ mode: z.literal("auto") }),
  z.object({
    mode: z.literal("specific"),
    gpuIndex: z.number().int().nonnegative(),
    vramLimitMB: z.number().int().positive().optional(),
  }),
]);

function gpuFreeGB(g: { vramFreeGB: number; committedVramGB: number }): number {
  return Math.max(0, g.vramFreeGB - g.committedVramGB);
}

function fitsRam(minRamGB: number, freeRamGB: number) {
  if (minRamGB <= freeRamGB) return { ok: true as const };
  return {
    ok: false as const,
    reason: `needs ${minRamGB.toFixed(1)} GB RAM, only ${freeRamGB.toFixed(1)} free`,
  };
}

function pickGPU(
  minVramGB: number,
  gpus: Array<{ index: number; name: string; vramFreeGB: number; committedVramGB: number }>,
): { index: number; vramFreeGB: number } | null {
  for (const g of gpus) {
    if (gpuFreeGB(g) >= minVramGB) return { index: g.index, vramFreeGB: gpuFreeGB(g) };
  }
  return null;
}

export const modelsRouter = router({
  capabilities: protectedProcedure.query(async ({ ctx }) => {
    return ctx.orchestrators.hosting.capabilities();
  }),

  catalogBackends: protectedProcedure.query(async ({ ctx }) => {
    return ctx.orchestrators.hosting.catalogBackends();
  }),

  catalogSearch: protectedProcedure
    .input(
      z.object({
        q: z.string().default(""),
        provider: z.enum(["dmr", "ollama"]).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      return ctx.orchestrators.hosting.catalogSearch({
        q: input.q,
        provider: input.provider,
      });
    }),

  catalogTags: protectedProcedure
    .input(
      z.object({
        ref: z.string().min(1),
        provider: z.enum(["dmr", "ollama"]).default("dmr"),
      }),
    )
    .query(async ({ ctx, input }) => {
      return ctx.orchestrators.hosting.catalogTags({
        ref: input.ref,
        provider: input.provider,
      });
    }),

  createFromRef: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80),
        description: z.string().max(500).optional(),
        runtime: runtimeSchema,
        ref: z.string().min(1),
        ramLimitGB: z.number().positive().optional(),
        cpuLimit: z.number().positive().optional(),
        gpu: gpuChoiceSchema.default({ mode: "auto" }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const cap = await ctx.orchestrators.hosting.capabilities();
      const freeRamGB = cap.freeRamGB - cap.committedRamGB;
      const freeCpu = Math.max(1, cap.cpuCores - cap.committedCpu);

      // Estimate or use provided RAM limit. Default = min(8 GB, free).
      const ramGB = input.ramLimitGB ?? Math.min(8, Math.max(2, freeRamGB - 1));
      const ramLimitMB = Math.round(ramGB * 1024);

      // Validate CPU override against host budget.
      if (input.cpuLimit && input.cpuLimit > freeCpu) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `CPU limit ${input.cpuLimit} exceeds free cores ${freeCpu.toFixed(1)}`,
        });
      }

      let gpuIndex: number | null = null;
      let vramLimitMB: number | null = null;
      if (input.gpu.mode === "auto" && cap.hasGPU) {
        const picked = pickGPU(2, cap.gpus); // assume 2 GB minimum guess
        if (picked) {
          gpuIndex = picked.index;
          vramLimitMB = Math.round(2 * 1024);
        }
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
        vramLimitMB = input.gpu.vramLimitMB ?? Math.round(2 * 1024);
      }

      const cpuLimit =
        input.cpuLimit ?? Math.max(1, Math.min(cap.cpuCores - cap.committedCpu, cap.cpuCores - 1));
      const slug = buildSlug(input.name);

      const [created] = await db
        .insert(modelProjects)
        .values({
          userId: ctx.user.id,
          name: input.name,
          slug,
          description: input.description,
          modelId: null,
          runtime: input.runtime,
          runtimeRef: input.ref,
          ramLimitMB,
          cpuLimit,
          gpuIndex: gpuIndex ?? undefined,
          vramLimitMB: vramLimitMB ?? undefined,
          status: "pending",
        })
        .returning();
      if (!created) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Enqueue the actual orchestrator call as a background job. createFromRef
      // returns instantly; web detail page polls until status flips to running.
      await ctx.queue.enqueueModelCreate({
        projectId: created.id,
        slug: created.slug,
        userId: ctx.user.id,
        runtime: input.runtime,
        ref: input.ref,
        ramLimitMB,
        cpuLimit,
        gpuIndex,
        vramLimitMB,
      });

      return created;
    }),

  catalog: protectedProcedure
    .input(z.object({ fitOnly: z.boolean().default(false) }).optional())
    .query(async ({ ctx, input }) => {
      const all = await db.select().from(models);
      const cap = await ctx.orchestrators.hosting.capabilities();
      const freeRamGB = cap.freeRamGB - cap.committedRamGB;

      const decorated = all.map((m) => {
        const ramFit = fitsRam(m.minRamGB, freeRamGB);
        let fitsCpu = ramFit.ok;
        let fitsAnyGpu = cap.hasGPU
          ? cap.gpus.some((g) => gpuFreeGB(g) >= m.minVramGB)
          : false;
        const fits = fitsCpu; // CPU mode possible whenever RAM fits.
        const reason = !ramFit.ok
          ? ramFit.reason
          : null;
        return {
          ...m,
          fits,
          fitsAnyGpu,
          unfitReason: reason,
        };
      });

      const filtered = input?.fitOnly ? decorated.filter((m) => m.fits) : decorated;
      filtered.sort((a, b) => a.parametersRaw - b.parametersRaw);
      return { capabilities: cap, models: filtered };
    }),

  list: protectedProcedure.query(async ({ ctx }) => {
    const projects = await db
      .select()
      .from(modelProjects)
      .where(eq(modelProjects.userId, ctx.user.id))
      .orderBy(desc(modelProjects.createdAt));
    if (projects.length === 0) return [];

    const projectIds = projects.map((p) => p.id);
    const tagRows = await db
      .select({
        projectId: modelProjectTags.projectId,
        id: projectTags.id,
        name: projectTags.name,
        color: projectTags.color,
      })
      .from(modelProjectTags)
      .innerJoin(projectTags, eq(modelProjectTags.tagId, projectTags.id))
      .where(inArray(modelProjectTags.projectId, projectIds));
    const tagsByProject = new Map<string, Array<{ id: string; name: string; color: string }>>();
    for (const r of tagRows) {
      const arr = tagsByProject.get(r.projectId) ?? [];
      arr.push({ id: r.id, name: r.name, color: r.color });
      tagsByProject.set(r.projectId, arr);
    }
    return projects.map((p) => ({ ...p, kind: "model" as const, tags: tagsByProject.get(p.id) ?? [] }));
  }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [project] = await db
        .select()
        .from(modelProjects)
        .where(and(eq(modelProjects.id, input.id), eq(modelProjects.userId, ctx.user.id)))
        .limit(1);
      if (!project) throw new TRPCError({ code: "NOT_FOUND" });

      let model: typeof models.$inferSelect | null = null;
      if (project.modelId) {
        const [row] = await db
          .select()
          .from(models)
          .where(eq(models.id, project.modelId))
          .limit(1);
        model = row ?? null;
      }
      return { ...project, kind: "model" as const, model };
    }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80),
        modelId: z.string(),
        runtime: runtimeSchema,
        description: z.string().max(500).optional(),
        gpu: gpuChoiceSchema.default({ mode: "auto" }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [model] = await db.select().from(models).where(eq(models.id, input.modelId)).limit(1);
      if (!model) throw new TRPCError({ code: "NOT_FOUND", message: "model not in catalog" });

      const runtime = model.runtimes.find((r) => r.kind === input.runtime);
      if (!runtime) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${input.runtime} not supported for this model`,
        });
      }

      const cap = await ctx.orchestrators.hosting.capabilities();
      const freeRamGB = cap.freeRamGB - cap.committedRamGB;

      const ramFit = fitsRam(model.minRamGB, freeRamGB);
      if (!ramFit.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `won't fit: ${ramFit.reason}` });
      }

      // Resolve GPU choice.
      let gpuIndex: number | null = null;
      let vramLimitMB: number | null = null;
      if (input.gpu.mode === "auto" && cap.hasGPU) {
        const picked = pickGPU(model.minVramGB, cap.gpus);
        if (picked) {
          gpuIndex = picked.index;
          vramLimitMB = Math.round(model.minVramGB * 1024);
        }
      } else if (input.gpu.mode === "specific") {

  const { gpuIndex: requestedGpuIndex } = input.gpu;

  const g = cap.gpus.find((x) => x.index === requestedGpuIndex);

  if (!g) {

    throw new TRPCError({

      code: "BAD_REQUEST",

      message: `GPU ${requestedGpuIndex} not found`,

    });

  }
        const free = gpuFreeGB(g);
        const requested = input.gpu.vramLimitMB ?? Math.round(model.minVramGB * 1024);
        if (requested / 1024 > free) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `won't fit: GPU ${g.index} has ${free.toFixed(1)} GB free, asked ${(
              requested / 1024
            ).toFixed(1)} GB`,
          });
        }
        if (requested / 1024 < model.minVramGB) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `model needs ${model.minVramGB.toFixed(1)} GB VRAM minimum`,
          });
        }
        gpuIndex = g.index;
        vramLimitMB = requested;
      }
      // mode === "off" → both stay null (CPU)

      const ramLimitMB = Math.round(model.recommendedRamGB * 1024);
      const cpuLimit = Math.max(1, Math.min(cap.cpuCores - cap.committedCpu, cap.cpuCores - 1));

      const slug = buildSlug(input.name);

      const [created] = await db
        .insert(modelProjects)
        .values({
          userId: ctx.user.id,
          name: input.name,
          slug,
          description: input.description,
          modelId: model.id,
          runtime: input.runtime,
          runtimeRef: runtime.reference,
          ramLimitMB,
          cpuLimit,
          gpuIndex: gpuIndex ?? undefined,
          vramLimitMB: vramLimitMB ?? undefined,
          status: "pending",
        })
        .returning();
      if (!created) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      await ctx.queue.enqueueModelCreate({
        projectId: created.id,
        slug: created.slug,
        userId: ctx.user.id,
        runtime: input.runtime,
        ref: runtime.reference,
        ramLimitMB,
        cpuLimit,
        gpuIndex,
        vramLimitMB,
      });

      return created;
    }),

  start: protectedProcedure
    .input(z.object({ projectId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [project] = await db
        .select()
        .from(modelProjects)
        .where(
          and(eq(modelProjects.id, input.projectId), eq(modelProjects.userId, ctx.user.id)),
        )
        .limit(1);
      if (!project) throw new TRPCError({ code: "NOT_FOUND" });
      if (!project.containerId) throw new TRPCError({ code: "BAD_REQUEST", message: "no container" });

      const result = await ctx.orchestrators.hosting.start({
        projectId: project.id,
        containerId: project.containerId,
      });
      const [updated] = await db
        .update(modelProjects)
        .set({
          status: "running",
          apiUrl: result.apiUrl ?? project.apiUrl,
          containerPort: result.containerPort ?? project.containerPort,
          updatedAt: new Date(),
        })
        .where(eq(modelProjects.id, project.id))
        .returning();
      return updated!;
    }),

  stop: protectedProcedure
    .input(z.object({ projectId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [project] = await db
        .select()
        .from(modelProjects)
        .where(
          and(eq(modelProjects.id, input.projectId), eq(modelProjects.userId, ctx.user.id)),
        )
        .limit(1);
      if (!project) throw new TRPCError({ code: "NOT_FOUND" });
      if (!project.containerId) throw new TRPCError({ code: "BAD_REQUEST", message: "no container" });

      await ctx.orchestrators.hosting.stop({ containerId: project.containerId });
      await db
        .update(modelProjects)
        .set({ status: "stopped", updatedAt: new Date() })
        .where(eq(modelProjects.id, project.id));
      return { ok: true as const };
    }),

  evictionCandidates: protectedProcedure.query(async ({ ctx }) => {
    const cap = await ctx.orchestrators.hosting.capabilities();
    const rows = await db
      .select()
      .from(modelProjects)
      .where(
        and(eq(modelProjects.userId, ctx.user.id), eq(modelProjects.status, "running")),
      )
      .orderBy(desc(modelProjects.ramLimitMB));

    const candidates = rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      runtime: r.runtime,
      runtimeRef: r.runtimeRef,
      ramLimitMB: r.ramLimitMB ?? 0,
      gpuIndex: r.gpuIndex,
      ramGB: (r.ramLimitMB ?? 0) / 1024,
    }));

    const freeRamGB = cap.freeRamGB - cap.committedRamGB;
    const freeVramGB = cap.gpus.reduce((s, g) => s + g.vramFreeGB, 0);
    return { candidates, freeRamGB, freeVramGB, hasGPU: cap.hasGPU, capabilities: cap };
  }),

  stats: protectedProcedure
    .input(z.object({ projectId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [project] = await db
        .select()
        .from(modelProjects)
        .where(
          and(eq(modelProjects.id, input.projectId), eq(modelProjects.userId, ctx.user.id)),
        )
        .limit(1);
      if (!project) throw new TRPCError({ code: "NOT_FOUND" });
      if (!project.containerId) throw new TRPCError({ code: "BAD_REQUEST", message: "no container" });
      if (project.status !== "running") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "container not running" });
      }
      return ctx.orchestrators.hosting.stats({ containerId: project.containerId });
    }),

  destroy: protectedProcedure
    .input(z.object({ projectId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [project] = await db
        .select()
        .from(modelProjects)
        .where(
          and(eq(modelProjects.id, input.projectId), eq(modelProjects.userId, ctx.user.id)),
        )
        .limit(1);
      if (!project) throw new TRPCError({ code: "NOT_FOUND" });
      if (project.containerId) {
        await ctx.orchestrators.hosting.destroy({ containerId: project.containerId });
      }
      await db
        .update(modelProjects)
        .set({
          status: "destroyed",
          containerId: null,
          containerPort: null,
          apiUrl: null,
          updatedAt: new Date(),
        })
        .where(eq(modelProjects.id, project.id));
      return { ok: true as const };
    }),
});
