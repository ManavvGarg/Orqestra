import type { OrchestratorClients } from "@orqestra/trpc";
import { env } from "@orqestra/env/api";
import { log } from "./log";

const headers = (): HeadersInit => ({
  "Content-Type": "application/json",
  "X-Internal-Secret": env.INTERNAL_API_SECRET,
});

async function call<T>(url: string, body?: unknown, method: "POST" | "GET" = "POST"): Promise<T> {
  const init: RequestInit = {
    method,
    headers: headers(),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    log.error({ url, status: res.status, body: text }, "orchestrator call failed");
    throw new Error(`Orchestrator ${url} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

export const orchestrators: OrchestratorClients = {
  jupyter: {
    create: (input) => call(`${env.ORCHESTRATOR_JUPYTER_URL}/internal/jupyter/create`, input),
    start: (input) => call(`${env.ORCHESTRATOR_JUPYTER_URL}/internal/jupyter/start`, input),
    stop: (input) => call(`${env.ORCHESTRATOR_JUPYTER_URL}/internal/jupyter/stop`, input),
    destroy: (input) => call(`${env.ORCHESTRATOR_JUPYTER_URL}/internal/jupyter/destroy`, input),
    stats: (input) => call(`${env.ORCHESTRATOR_JUPYTER_URL}/internal/jupyter/stats`, input),
    list: (input) => call(`${env.ORCHESTRATOR_JUPYTER_URL}/internal/jupyter/list`, input),
  },
  hosting: {
    capabilities: () =>
      call(`${env.ORCHESTRATOR_HOSTING_URL}/internal/hosting/capabilities`, undefined, "GET"),
    create: (input) =>
      call(`${env.ORCHESTRATOR_HOSTING_URL}/internal/hosting/create`, {
        ...input,
        vramLimitMB: input.vramLimitMB ?? 0,
      }),
    start: (input) => call(`${env.ORCHESTRATOR_HOSTING_URL}/internal/hosting/start`, input),
    stop: (input) => call(`${env.ORCHESTRATOR_HOSTING_URL}/internal/hosting/stop`, input),
    destroy: (input) => call(`${env.ORCHESTRATOR_HOSTING_URL}/internal/hosting/destroy`, input),
    stats: (input) => call(`${env.ORCHESTRATOR_HOSTING_URL}/internal/hosting/stats`, input),
    catalogBackends: () =>
      call(`${env.ORCHESTRATOR_HOSTING_URL}/internal/hosting/catalog/backends`, undefined, "GET"),
    catalogSearch: (input) => {
      const params = new URLSearchParams();
      if (input.q) params.set("q", input.q);
      if (input.provider) params.set("provider", input.provider);
      return call(
        `${env.ORCHESTRATOR_HOSTING_URL}/internal/hosting/catalog/search?${params.toString()}`,
        undefined,
        "GET",
      );
    },
    catalogTags: (input) => {
      const params = new URLSearchParams();
      params.set("ref", input.ref);
      if (input.provider) params.set("provider", input.provider);
      return call(
        `${env.ORCHESTRATOR_HOSTING_URL}/internal/hosting/catalog/tags?${params.toString()}`,
        undefined,
        "GET",
      );
    },
    modelReady: (input) =>
      call(`${env.ORCHESTRATOR_HOSTING_URL}/internal/hosting/model-ready`, input),
  },
};
