import type { User } from "@orqestra/db";

export interface HostGPU {
  index: number;
  name: string;
  vramTotalGB: number;
  vramFreeGB: number;
  committedVramGB: number;
}

export interface HostCapabilities {
  totalRamGB: number;
  freeRamGB: number;
  cpuCores: number;
  gpus: HostGPU[];
  hasGPU: boolean;
  os: string;
  kernelVersion: string;
  /** Sum of `ramLimitMB` over running model containers, in GB. */
  committedRamGB: number;
  /** Sum of running container CPU limits. */
  committedCpu: number;
}

export interface OrchestratorClients {
  jupyter: {
    create(input: {
      projectId: string;
      slug: string;
      userId: string;
      jobType: "base" | "tensorflow" | "pytorch" | "r";
      volumeName: string;
      gpuIndex?: number | null;
      vramLimitMB?: number | null;
      cpuLimit?: string;
      memoryLimit?: string;
    }): Promise<{
      containerId: string;
      containerUrl: string;
      containerToken: string;
      containerPort: number;
    }>;
    start(input: { containerId: string }): Promise<{
      containerUrl?: string;
      containerPort?: number;
    }>;
    stop(input: { containerId: string }): Promise<{ ok: true }>;
    destroy(input: { containerId: string; volumeName: string }): Promise<{ ok: true }>;
    list(input: { containerId: string; path: string }): Promise<{
      path: string;
      entries: Array<{ name: string; type: "file" | "dir" | "symlink"; size: number; modifiedAt: number }>;
    }>;
    stats(input: { containerId: string }): Promise<{
      cpuPercent: number;
      memoryUsageBytes: number;
      memoryLimitBytes: number;
      memoryPercent: number;
      readAt: string;
    }>;
  };
  hosting: {
    capabilities(): Promise<HostCapabilities>;
    create(input: {
      projectId: string;
      slug: string;
      userId: string;
      runtime: "ollama" | "docker-model-runner" | "llama-cpp";
      runtimeRef: string;
      ramLimitMB: number;
      cpuLimit: number;
      gpuIndex: number | null;
      vramLimitMB: number | null;
    }): Promise<{
      containerId: string;
      containerPort: number;
      apiUrl: string;
    }>;
    start(input: { projectId: string; containerId: string }): Promise<{
      apiUrl?: string;
      containerPort?: number;
    }>;
    stop(input: { containerId: string }): Promise<{ ok: true }>;
    destroy(input: { containerId: string }): Promise<{ ok: true }>;
    stats(input: { containerId: string }): Promise<{
      cpuPercent: number;
      memoryUsageBytes: number;
      memoryLimitBytes: number;
      memoryPercent: number;
      readAt: string;
    }>;
    catalogBackends(): Promise<{
      dmrInstalled: boolean;
      dmrBackends: string[];
      ollamaPresent: boolean;
    }>;
    catalogSearch(input: { q?: string; provider?: "dmr" | "ollama" }): Promise<{
      models: Array<{
        name: string;
        description: string;
        backend: string;
        source: string;
        provider: "dmr" | "ollama" | "huggingface";
        pullCount: number;
        starCount: number;
      }>;
    }>;
    catalogTags(input: { ref: string; provider?: "dmr" | "ollama" }): Promise<{
      ref: string;
      provider: string;
      tags: Array<{ name: string; sizeBytes: number; lastUpdated: string }>;
    }>;
    modelReady(input: {
      containerId: string;
      ref: string;
      runtime: "ollama" | "docker-model-runner" | "llama-cpp";
    }): Promise<{ ready: boolean; error?: string }>;
  };
}

export interface JobQueue {
  enqueueModelCreate(input: {
    projectId: string;
    slug: string;
    userId: string;
    runtime: "ollama" | "docker-model-runner" | "llama-cpp";
    ref: string;
    ramLimitMB: number;
    cpuLimit: number;
    gpuIndex: number | null;
    vramLimitMB: number | null;
  }): Promise<void>;
  enqueueModelReadyCheck(input: {
    projectId: string;
    containerId: string;
    ref: string;
    runtime: "ollama" | "docker-model-runner" | "llama-cpp";
  }): Promise<void>;
}

export interface TrpcContext {
  user: User | null;
  sessionId: string | null;
  orchestrators: OrchestratorClients;
  queue: JobQueue;
  ip: string | null;
}
