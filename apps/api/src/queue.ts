import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { db, models, modelProjects, eq } from "@orqestra/db";
import { refreshCatalog } from "@orqestra/models/refresh";
import { env } from "@orqestra/env/api";
import { orchestrators } from "./orchestrator-clients";
import { log } from "./log";

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const catalogQueue = new Queue("catalog-refresh", { connection });

const REFRESH_JOB = "refresh";

export async function ensureCatalogSchedule() {
  await catalogQueue.add(
    REFRESH_JOB,
    {},
    {
      jobId: "catalog-refresh-hourly",
      repeat: { every: 60 * 60 * 1000 },
      removeOnComplete: { count: 24 },
      removeOnFail: { count: 24 },
    },
  );
  // Kick once on boot so catalog is populated immediately.
  await catalogQueue.add(REFRESH_JOB, {}, { jobId: `catalog-bootstrap-${Date.now()}` });
}

export function startCatalogWorker(): Worker {
  const worker = new Worker(
    "catalog-refresh",
    async () => {
      log.info("refreshing catalog");
      const catalog = await refreshCatalog();
      for (const m of catalog.models) {
        await db
          .insert(models)
          .values({
            id: m.id,
            name: m.name,
            provider: m.provider,
            parameterCount: m.parameterCount,
            parametersRaw: m.parametersRaw,
            activeParameters: m.activeParameters,
            isMoe: m.isMoe,
            minRamGB: m.minRamGB,
            recommendedRamGB: m.recommendedRamGB,
            minVramGB: m.minVramGB,
            contextLength: m.contextLength,
            capabilities: m.capabilities,
            useCase: m.useCase,
            pipelineTag: m.pipelineTag,
            architecture: m.architecture,
            hfRepo: m.hfRepo,
            hfDownloads: m.hfDownloads,
            hfLikes: m.hfLikes,
            releaseDate: m.releaseDate ?? null,
            runtimes: m.runtimes,
            updatedAt: new Date(m.updatedAt),
          })
          .onConflictDoUpdate({
            target: models.id,
            set: {
              name: m.name,
              provider: m.provider,
              parameterCount: m.parameterCount,
              parametersRaw: m.parametersRaw,
              activeParameters: m.activeParameters,
              isMoe: m.isMoe,
              minRamGB: m.minRamGB,
              recommendedRamGB: m.recommendedRamGB,
              minVramGB: m.minVramGB,
              contextLength: m.contextLength,
              capabilities: m.capabilities,
              useCase: m.useCase,
              pipelineTag: m.pipelineTag,
              architecture: m.architecture,
              hfRepo: m.hfRepo,
              hfDownloads: m.hfDownloads,
              hfLikes: m.hfLikes,
              releaseDate: m.releaseDate ?? null,
              runtimes: m.runtimes,
              updatedAt: new Date(m.updatedAt),
            },
          });
      }
      log.info({ count: catalog.models.length }, "catalog updated");
    },
    { connection, concurrency: 1 },
  );

  worker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, error: err instanceof Error ? err.message : String(err) }, "catalog refresh failed");
  });

  return worker;
}

// ----------------------------------------------------------------
// Model-ready poller — flips modelProjects.status pulling → running
// once the orchestrator reports the ref is available.
// ----------------------------------------------------------------

interface ModelCreateJob {
  projectId: string;
  slug: string;
  userId: string;
  runtime: "ollama" | "docker-model-runner" | "llama-cpp";
  ref: string;
  ramLimitMB: number;
  cpuLimit: number;
  gpuIndex: number | null;
  vramLimitMB: number | null;
}

interface ModelReadyJob {
  projectId: string;
  containerId: string;
  ref: string;
  runtime: "ollama" | "docker-model-runner" | "llama-cpp";
  startedAt: number;
}

const MODEL_CREATE_QUEUE = "model-create";
const MODEL_READY_QUEUE = "model-ready";
const MODEL_READY_TIMEOUT_MS = 30 * 60 * 1000; // 30 min hard cap
const MODEL_READY_INTERVAL_MS = 5_000;

export const modelCreateQueue = new Queue<ModelCreateJob>(MODEL_CREATE_QUEUE, { connection });
export const modelReadyQueue = new Queue<ModelReadyJob>(MODEL_READY_QUEUE, { connection });

export async function enqueueModelCreate(input: ModelCreateJob) {
  await modelCreateQueue.add("create", input, {
    jobId: `model-create-${input.projectId}`,
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
    attempts: 1,
  });
}

export async function enqueueModelReadyCheck(input: {
  projectId: string;
  containerId: string;
  ref: string;
  runtime: ModelReadyJob["runtime"];
}) {
  await modelReadyQueue.add(
    "check",
    { ...input, startedAt: Date.now() },
    {
      jobId: `model-ready-${input.projectId}`,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 50 },
      attempts: 1,
    },
  );
}

export function startModelCreateWorker(): Worker<ModelCreateJob> {
  const worker = new Worker<ModelCreateJob>(
    MODEL_CREATE_QUEUE,
    async (job: Job<ModelCreateJob>) => {
      const j = job.data;
      log.info({ projectId: j.projectId, ref: j.ref, runtime: j.runtime }, "model create starting");

      // Mark pulling early so detail page polls (covers image-pull window).
      await db
        .update(modelProjects)
        .set({ status: "pulling", updatedAt: new Date() })
        .where(eq(modelProjects.id, j.projectId));

      try {
        const result = await orchestrators.hosting.create({
          projectId: j.projectId,
          slug: j.slug,
          userId: j.userId,
          runtime: j.runtime,
          runtimeRef: j.ref,
          ramLimitMB: j.ramLimitMB,
          cpuLimit: j.cpuLimit,
          gpuIndex: j.gpuIndex,
          vramLimitMB: j.vramLimitMB,
        });

        await db
          .update(modelProjects)
          .set({
            containerId: result.containerId,
            containerPort: result.containerPort,
            apiUrl: result.apiUrl,
            updatedAt: new Date(),
          })
          .where(eq(modelProjects.id, j.projectId));

        await enqueueModelReadyCheck({
          projectId: j.projectId,
          containerId: result.containerId,
          ref: j.ref,
          runtime: j.runtime,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "create failed";
        log.error({ projectId: j.projectId, error: message }, "model create failed");
        await db
          .update(modelProjects)
          .set({ status: "errored", errorMessage: message, updatedAt: new Date() })
          .where(eq(modelProjects.id, j.projectId));
      }
    },
    { connection, concurrency: 2 },
  );
  worker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, error: err instanceof Error ? err.message : String(err) }, "model-create job failed");
  });
  return worker;
}

export function startModelReadyWorker(): Worker<ModelReadyJob> {
  const worker = new Worker<ModelReadyJob>(
    MODEL_READY_QUEUE,
    async (job: Job<ModelReadyJob>) => {
      const { projectId, containerId, ref, runtime, startedAt } = job.data;
      const deadline = startedAt + MODEL_READY_TIMEOUT_MS;

      // Grace period — daemon startup + first pull bytes. Without it, an
      // early `ollama list` race can briefly hit a known-cached entry.
      await new Promise((r) => setTimeout(r, 15_000));

      while (Date.now() < deadline) {
        // Bail if project deleted or status manually changed away from pulling.
        const [proj] = await db
          .select()
          .from(modelProjects)
          .where(eq(modelProjects.id, projectId))
          .limit(1);
        if (!proj) return;
        if (proj.status !== "pulling" && proj.status !== "pending") return;

        try {
          const { ready, error } = await orchestrators.hosting.modelReady({
            containerId,
            ref,
            runtime,
          });
          if (ready) {
            await db
              .update(modelProjects)
              .set({ status: "running", updatedAt: new Date() })
              .where(eq(modelProjects.id, projectId));
            log.info({ projectId, ref }, "model ready");
            return;
          }
          if (error) {
            log.debug({ projectId, ref, error }, "model not ready yet");
          }
        } catch (err) {
          log.debug(
            { projectId, error: err instanceof Error ? err.message : String(err) },
            "model-ready probe failed",
          );
        }
        await new Promise((r) => setTimeout(r, MODEL_READY_INTERVAL_MS));
      }

      // Timed out — mark errored.
      await db
        .update(modelProjects)
        .set({
          status: "errored",
          errorMessage: `pull timeout after ${MODEL_READY_TIMEOUT_MS / 60_000}m`,
          updatedAt: new Date(),
        })
        .where(eq(modelProjects.id, projectId));
      log.warn({ projectId, ref }, "model-ready timeout");
    },
    { connection, concurrency: 4 },
  );

  worker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, error: err instanceof Error ? err.message : String(err) }, "model-ready job failed");
  });

  return worker;
}
