import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  and,
  db,
  desc,
  eq,
  inArray,
  modelProjects,
  swarmMessages,
  swarmRuns,
  swarmThreads,
  swarms,
  type SwarmSpec,
} from "@orqestra/db";
import { router, protectedProcedure } from "../trpc";
import { buildSlug } from "../util/slug";

const llmProviderSchema = z.enum([
  "anthropic",
  "gemini",
  "groq",
  "mistral",
  "deepseek",
  "openrouter",
  "together_ai",
  "xai",
  "fireworks_ai",
  "cohere",
]);

const llmSchema = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("openai"), model: z.string().min(1) }),
  z.object({
    backend: z.literal("provider"),
    provider: llmProviderSchema,
    model: z.string().min(1),
  }),
  z.object({ backend: z.literal("local"), modelProjectId: z.string().uuid() }),
]);

/** Provider id -> the env var LiteLLM reads for that provider's key.
 *  openai is handled separately via the existing openaiApiKey path. */
const PROVIDER_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  together_ai: "TOGETHERAI_API_KEY",
  xai: "XAI_API_KEY",
  fireworks_ai: "FIREWORKS_AI_API_KEY",
  cohere: "COHERE_API_KEY",
};

const agentDefSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "agent name must be a valid identifier"),
  role: z.string().min(1).max(120),
  instructions: z.string().min(1).max(20_000),
  llm: llmSchema,
  tools: z
    .array(
      z.object({
        type: z.literal("builtin"),
        name: z.enum(["send_message", "handoff"]),
      }),
    )
    .optional(),
});

const flowSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  via: z.enum(["send_message", "handoff"]),
});

const specSchema = z
  .object({
    agents: z.array(agentDefSchema).min(1).max(20),
    communicationFlows: z.array(flowSchema).max(200),
    orchestration: z.object({
      entryAgent: z.string().min(1),
      defaultPattern: z.enum(["auto", "handoff", "orchestrator_worker"]),
    }),
  })
  .superRefine((spec, ctx) => {
    const names = new Set(spec.agents.map((a) => a.name));
    if (names.size !== spec.agents.length) {
      ctx.addIssue({ code: "custom", message: "agent names must be unique" });
    }
    if (!names.has(spec.orchestration.entryAgent)) {
      ctx.addIssue({
        code: "custom",
        message: `entryAgent "${spec.orchestration.entryAgent}" not in agents`,
      });
    }
    for (const f of spec.communicationFlows) {
      if (!names.has(f.from)) {
        ctx.addIssue({ code: "custom", message: `flow.from "${f.from}" not in agents` });
      }
      if (!names.has(f.to)) {
        ctx.addIssue({ code: "custom", message: `flow.to "${f.to}" not in agents` });
      }
      if (f.from === f.to) {
        ctx.addIssue({ code: "custom", message: `self-flow not allowed: ${f.from}` });
      }
    }
  });

type ResolvedLocalModel = {
  /** Docker-network-internal base URL the harness dials. */
  url: string;
  /** The model id the runtime knows it by — ollama's tag, e.g. "smollm2:latest".
   *  Must be sent in the OpenAI-compat request body or the runtime 404s. */
  modelName: string;
};

/**
 * Validate that every local-backend agent references a model_project owned by
 * the caller, and return a map of modelProjectId -> {url, modelName} for the
 * harness. Throws BAD_REQUEST on any unowned / not-running model.
 */
async function resolveLocalModels(
  spec: SwarmSpec,
  userId: string,
): Promise<Map<string, ResolvedLocalModel>> {
  const localIds = spec.agents
    .filter((a) => a.llm.backend === "local")
    .map((a) => (a.llm as { backend: "local"; modelProjectId: string }).modelProjectId);
  const out = new Map<string, ResolvedLocalModel>();
  if (localIds.length === 0) return out;
  const rows = await db
    .select({
      id: modelProjects.id,
      apiUrl: modelProjects.apiUrl,
      internalApiUrl: modelProjects.internalApiUrl,
      runtimeRef: modelProjects.runtimeRef,
      status: modelProjects.status,
    })
    .from(modelProjects)
    .where(and(eq(modelProjects.userId, userId), inArray(modelProjects.id, localIds)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of localIds) {
    const row = byId.get(id);
    if (!row) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `local model_project ${id} not owned by user`,
      });
    }
    if (row.status !== "running") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `model_project ${id} status is "${row.status}" — must be running`,
      });
    }
    // The harness runs in its own container, so it must use the
    // docker-network-internal URL (container name), not the host-facing
    // apiUrl. Fall back to apiUrl for model_projects created before the
    // internalApiUrl column existed (those need a recreate to work in swarms).
    const url = row.internalApiUrl ?? row.apiUrl;
    if (!url) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `model_project ${id} has no reachable URL — recreate it, then reference it in a swarm`,
      });
    }
    out.set(id, { url, modelName: row.runtimeRef });
  }
  return out;
}

/**
 * Build a resolved spec where every local agent's llm has apiUrl + modelName
 * baked in. The DB-stored spec keeps just the modelProjectId (URLs may drift
 * across recreates of the hosted model); the resolved spec is only what the
 * Python harness sees.
 */
function resolveSpec(spec: SwarmSpec, resolved: Map<string, ResolvedLocalModel>): SwarmSpec {
  return {
    ...spec,
    agents: spec.agents.map((a) => {
      if (a.llm.backend !== "local") return a;
      const r = resolved.get(a.llm.modelProjectId);
      return {
        ...a,
        llm: {
          ...a.llm,
          // SwarmSpec type does not declare these; the harness expects them.
          apiUrl: r?.url,
          modelName: r?.modelName,
        } as typeof a.llm & { apiUrl?: string; modelName?: string },
      };
    }),
  };
}

export const agenthiveRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80),
        description: z.string().max(500).optional(),
        spec: specSchema,
        openaiApiKey: z.string().optional(),
        /** provider id -> API key, for every non-openai provider used by an
         *  agent. Validated below; never persisted, only passed as container
         *  env vars. */
        providerKeys: z.record(llmProviderSchema, z.string().min(1)).optional(),
        cpuLimit: z.string().optional(),
        memoryLimit: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const localUrls = await resolveLocalModels(input.spec, ctx.user.id);
      const resolvedSpec = resolveSpec(input.spec, localUrls);
      const slug = buildSlug(input.name);

      // Every provider an agent uses must have a key. Build the env-var map the
      // orchestrator injects into the harness container.
      const providerKeys = input.providerKeys ?? {};
      const envKeys: Record<string, string> = {};
      const usedProviders = new Set(
        input.spec.agents
          .filter((a) => a.llm.backend === "provider")
          .map((a) => (a.llm as { backend: "provider"; provider: string }).provider),
      );
      for (const provider of usedProviders) {
        const key = providerKeys[provider as keyof typeof providerKeys];
        if (!key) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `missing API key for provider "${provider}"`,
          });
        }
        const envName = PROVIDER_ENV[provider];
        if (envName) envKeys[envName] = key;
      }
      const usesOpenAI = input.spec.agents.some((a) => a.llm.backend === "openai");
      if (usesOpenAI) {
        if (!input.openaiApiKey) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "missing OpenAI API key — an agent uses the openai backend",
          });
        }
        envKeys.OPENAI_API_KEY = input.openaiApiKey;
      }

      const [created] = await db
        .insert(swarms)
        .values({
          userId: ctx.user.id,
          name: input.name,
          slug,
          description: input.description,
          spec: input.spec,
          status: "creating",
          cpuLimit: input.cpuLimit,
          memoryLimit: input.memoryLimit,
        })
        .returning();
      if (!created) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      try {
        const result = await ctx.orchestrators.agenthive.create({
          swarmId: created.id,
          slug: created.slug,
          userId: ctx.user.id,
          specJson: JSON.stringify(resolvedSpec),
          envKeys,
          cpuLimit: input.cpuLimit,
          memoryLimit: input.memoryLimit,
        });
        const [updated] = await db
          .update(swarms)
          .set({
            containerId: result.containerId,
            containerPort: result.containerPort,
            status: "running",
            updatedAt: new Date(),
          })
          .where(eq(swarms.id, created.id))
          .returning();
        return updated!;
      } catch (err) {
        await db
          .update(swarms)
          .set({ status: "errored", updatedAt: new Date() })
          .where(eq(swarms.id, created.id));
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error ? err.message : "Orchestrator failed",
        });
      }
    }),

  start: protectedProcedure
    .input(z.object({ swarmId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await db
        .select()
        .from(swarms)
        .where(and(eq(swarms.id, input.swarmId), eq(swarms.userId, ctx.user.id)))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      if (!row.containerId) throw new TRPCError({ code: "BAD_REQUEST", message: "No container" });
      const r = await ctx.orchestrators.agenthive.start({ containerId: row.containerId });
      const [updated] = await db
        .update(swarms)
        .set({
          status: "running",
          containerPort: r.containerPort ?? row.containerPort,
          updatedAt: new Date(),
        })
        .where(eq(swarms.id, row.id))
        .returning();
      return updated!;
    }),

  stop: protectedProcedure
    .input(z.object({ swarmId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await db
        .select()
        .from(swarms)
        .where(and(eq(swarms.id, input.swarmId), eq(swarms.userId, ctx.user.id)))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      if (!row.containerId) throw new TRPCError({ code: "BAD_REQUEST", message: "No container" });
      await ctx.orchestrators.agenthive.stop({ containerId: row.containerId });
      await db
        .update(swarms)
        .set({ status: "stopped", updatedAt: new Date() })
        .where(eq(swarms.id, row.id));
      return { ok: true as const };
    }),

  destroy: protectedProcedure
    .input(z.object({ swarmId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await db
        .select()
        .from(swarms)
        .where(and(eq(swarms.id, input.swarmId), eq(swarms.userId, ctx.user.id)))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      if (row.containerId) {
        await ctx.orchestrators.agenthive.destroy({ containerId: row.containerId });
      }
      await db
        .update(swarms)
        .set({
          status: "destroyed",
          containerId: null,
          containerPort: null,
          updatedAt: new Date(),
        })
        .where(eq(swarms.id, row.id));
      return { ok: true as const };
    }),

  /**
   * Permanent deletion: stop+remove container, then delete swarm row.
   * FK cascades remove swarm_threads, swarm_messages, swarm_runs, swarm_tags.
   * Use destroy() if you want to keep history; this is irreversible.
   */
  delete: protectedProcedure
    .input(z.object({ swarmId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await db
        .select()
        .from(swarms)
        .where(and(eq(swarms.id, input.swarmId), eq(swarms.userId, ctx.user.id)))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      if (row.containerId) {
        try {
          await ctx.orchestrators.agenthive.destroy({ containerId: row.containerId });
        } catch (err) {
          // Container may already be gone; log via thrown error message but
          // proceed with DB delete so the user isn't stuck with orphan rows.
          console.warn("agenthive.delete: orchestrator destroy failed", err);
        }
      }
      await db.delete(swarms).where(eq(swarms.id, row.id));
      return { ok: true as const };
    }),

  stats: protectedProcedure
    .input(z.object({ swarmId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [row] = await db
        .select()
        .from(swarms)
        .where(and(eq(swarms.id, input.swarmId), eq(swarms.userId, ctx.user.id)))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      if (!row.containerId) throw new TRPCError({ code: "BAD_REQUEST", message: "No container" });
      if (row.status !== "running") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Not running" });
      }
      return ctx.orchestrators.agenthive.stats({ containerId: row.containerId });
    }),

  // --- Threads ---

  createThread: protectedProcedure
    .input(z.object({ swarmId: z.string().uuid(), title: z.string().max(120).optional() }))
    .mutation(async ({ ctx, input }) => {
      const [swarm] = await db
        .select({ id: swarms.id })
        .from(swarms)
        .where(and(eq(swarms.id, input.swarmId), eq(swarms.userId, ctx.user.id)))
        .limit(1);
      if (!swarm) throw new TRPCError({ code: "NOT_FOUND" });
      const [thread] = await db
        .insert(swarmThreads)
        .values({ swarmId: input.swarmId, userId: ctx.user.id, title: input.title })
        .returning();
      return thread!;
    }),

  listThreads: protectedProcedure
    .input(z.object({ swarmId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [swarm] = await db
        .select({ id: swarms.id })
        .from(swarms)
        .where(and(eq(swarms.id, input.swarmId), eq(swarms.userId, ctx.user.id)))
        .limit(1);
      if (!swarm) throw new TRPCError({ code: "NOT_FOUND" });
      return db
        .select()
        .from(swarmThreads)
        .where(eq(swarmThreads.swarmId, input.swarmId))
        .orderBy(desc(swarmThreads.createdAt));
    }),

  listMessages: protectedProcedure
    .input(z.object({ threadId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [thread] = await db
        .select()
        .from(swarmThreads)
        .where(and(eq(swarmThreads.id, input.threadId), eq(swarmThreads.userId, ctx.user.id)))
        .limit(1);
      if (!thread) throw new TRPCError({ code: "NOT_FOUND" });
      return db
        .select()
        .from(swarmMessages)
        .where(eq(swarmMessages.threadId, input.threadId))
        .orderBy(swarmMessages.createdAt);
    }),

  // --- Runs ---

  startRun: protectedProcedure
    .input(
      z.object({
        threadId: z.string().uuid(),
        userMessage: z.string().min(1).max(50_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [thread] = await db
        .select()
        .from(swarmThreads)
        .where(and(eq(swarmThreads.id, input.threadId), eq(swarmThreads.userId, ctx.user.id)))
        .limit(1);
      if (!thread) throw new TRPCError({ code: "NOT_FOUND" });

      const [swarm] = await db
        .select()
        .from(swarms)
        .where(eq(swarms.id, thread.swarmId))
        .limit(1);
      if (!swarm) throw new TRPCError({ code: "NOT_FOUND" });
      if (swarm.status !== "running" || !swarm.containerId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Swarm not running" });
      }

      // Persist the user message immediately so the UI history is consistent.
      await db.insert(swarmMessages).values({
        threadId: thread.id,
        sender: null,
        receiver: swarm.spec.orchestration.entryAgent,
        role: "user",
        content: { type: "text", text: input.userMessage },
      });

      const [run] = await db
        .insert(swarmRuns)
        .values({ swarmId: swarm.id, threadId: thread.id, status: "queued" })
        .returning();
      if (!run) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      await ctx.queue.enqueueAgenthiveRun({
        runId: run.id,
        swarmId: swarm.id,
        threadId: thread.id,
        userMessage: input.userMessage,
      });
      return run;
    }),

  listRuns: protectedProcedure
    .input(z.object({ swarmId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [swarm] = await db
        .select({ id: swarms.id })
        .from(swarms)
        .where(and(eq(swarms.id, input.swarmId), eq(swarms.userId, ctx.user.id)))
        .limit(1);
      if (!swarm) throw new TRPCError({ code: "NOT_FOUND" });
      return db
        .select()
        .from(swarmRuns)
        .where(eq(swarmRuns.swarmId, input.swarmId))
        .orderBy(desc(swarmRuns.createdAt))
        .limit(50);
    }),
});
