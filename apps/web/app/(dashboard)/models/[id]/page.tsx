"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { useSession } from "@/lib/auth-client";
import { LogStream } from "@/components/log-stream";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Copy, Cpu, MemoryStick, Play, Square, Trash2 } from "lucide-react";
import {
  ResourceMeter,
  formatBytes,
  formatPercent,
} from "@/components/resource-meter";

export default function ModelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.projects.getById.useQuery(
    { id, kind: "model" },
    {
      refetchInterval: (q) =>
        q.state.data?.kind === "model" &&
        (q.state.data.status === "pulling" || q.state.data.status === "pending")
          ? 2000
          : false,
    },
  );
  const statsQuery = trpc.models.stats.useQuery(
    { projectId: id },
    {
      enabled: data?.kind === "model" && data.status === "running",
      refetchInterval: 2000,
    },
  );

  const start = trpc.models.start.useMutation({
    onSuccess: () => utils.projects.getById.invalidate({ id, kind: "model" }),
  });
  const stop = trpc.models.stop.useMutation({
    onSuccess: () => utils.projects.getById.invalidate({ id, kind: "model" }),
  });
  const destroy = trpc.models.destroy.useMutation({
    onSuccess: () => router.push("/dashboard"),
  });

  const [copied, setCopied] = useState(false);

  if (isLoading || !data) return <div className="text-sm text-[var(--color-muted)]">Loading…</div>;
  if (data.kind !== "model") return null;
  const p = data;
  const m = p.model;

  const isRunning = p.status === "running";
  const isStopped = p.status === "stopped";
  const isDestroyed = p.status === "destroyed";

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  const curlSample = p.apiUrl
    ? `curl -X POST ${p.apiUrl}/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${p.runtimeRef}","messages":[{"role":"user","content":"Hello"}]}'`
    : "";

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{p.name}</h1>
          <p className="text-sm text-[var(--color-muted)]">
            {m?.name ?? p.modelId ?? p.runtimeRef} · <span className="font-mono">{p.slug}</span>
          </p>
        </div>
        <StatusBadge status={p.status} />
      </div>

      {p.description ? (
        <p className="mb-6 text-sm text-[var(--color-muted)]">{p.description}</p>
      ) : null}

      <div className="mb-6 grid grid-cols-1 gap-3 rounded-md border border-[var(--color-border)] p-4 text-sm md:grid-cols-2">
        <div className="md:col-span-2">
          <div className="text-xs uppercase tracking-wide text-[var(--color-muted)]">API URL</div>
          {isRunning && p.apiUrl ? (
            <div className="mt-1 flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-white/5 px-2 py-1 text-xs">
                {p.apiUrl}
              </code>
              <Button size="sm" variant="ghost" onClick={() => copy(p.apiUrl!)}>
                <Copy className="h-3 w-3" />
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          ) : (
            <div className="mt-1 text-[var(--color-muted)]">
              {p.status === "pulling" ? "Pulling model…" : "—"}
              {p.errorMessage ? <span className="ml-2 text-[var(--color-error)]">{p.errorMessage}</span> : null}
            </div>
          )}
        </div>
        <Field label="Runtime" value={runtimeLabel(p.runtime)} />
        <Field label="Tag" value={p.runtimeRef} mono />
        <Field
          label="RAM limit"
          value={p.ramLimitMB ? `${(p.ramLimitMB / 1024).toFixed(1)} GB` : "—"}
        />
        <Field label="CPU limit" value={p.cpuLimit ? `${p.cpuLimit} cores` : "—"} />
        <Field
          label="GPU"
          value={
            p.gpuIndex !== null && p.gpuIndex !== undefined
              ? `index ${p.gpuIndex}${
                  p.vramLimitMB ? ` · ${(p.vramLimitMB / 1024).toFixed(1)} GB VRAM` : ""
                }`
              : "CPU"
          }
        />
        <Field label="Created" value={new Date(p.createdAt as any).toLocaleString()} />
      </div>

      {isRunning ? (
        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          <ResourceMeter
            icon={Cpu}
            label="Container CPU"
            value={formatPercent(statsQuery.data?.cpuPercent)}
            detail={
              statsQuery.data
                ? `Updated ${new Date(statsQuery.data.readAt).toLocaleTimeString()}`
                : statsQuery.error
                  ? "Stats unavailable"
                  : "Collecting"
            }
            percent={statsQuery.data?.cpuPercent ?? 0}
          />
          <ResourceMeter
            icon={MemoryStick}
            label="Container RAM"
            value={formatBytes(statsQuery.data?.memoryUsageBytes)}
            detail={
              statsQuery.data
                ? `${formatPercent(statsQuery.data.memoryPercent)} of ${formatBytes(statsQuery.data.memoryLimitBytes)}`
                : "Collecting"
            }
            percent={statsQuery.data?.memoryPercent ?? 0}
          />
        </div>
      ) : null}

      {curlSample ? (
        <div className="mb-6">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
              Sample curl
            </span>
            <Button size="sm" variant="ghost" onClick={() => copy(curlSample)}>
              <Copy className="h-3 w-3" /> Copy
            </Button>
          </div>
          <pre className="overflow-x-auto rounded-md border border-[var(--color-border)] bg-black p-3 text-xs">
            {curlSample}
          </pre>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {isStopped ? (
          <Button
            variant="outline"
            disabled={start.isPending}
            onClick={() => start.mutate({ projectId: p.id })}
          >
            <Play className="h-3.5 w-3.5" />
            {start.isPending ? "Starting…" : "Start"}
          </Button>
        ) : null}
        {isRunning ? (
          <Button
            variant="outline"
            disabled={stop.isPending}
            onClick={() => stop.mutate({ projectId: p.id })}
          >
            <Square className="h-3.5 w-3.5" />
            {stop.isPending ? "Stopping…" : "Stop"}
          </Button>
        ) : null}
        {!isDestroyed ? (
          <Button
            variant="destructive"
            disabled={destroy.isPending}
            onClick={() => {
              if (confirm("Destroy model project? This stops + removes the container.")) {
                destroy.mutate({ projectId: p.id });
              }
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {destroy.isPending ? "Destroying…" : "Destroy"}
          </Button>
        ) : null}
      </div>

      {start.error ? (
        <div className="mt-3 text-sm text-[var(--color-error)]">{start.error.message}</div>
      ) : null}

      <ModelLogs projectId={p.id} containerId={p.containerId ?? null} />
    </div>
  );
}

function ModelLogs({
  projectId,
  containerId,
}: {
  projectId: string;
  containerId: string | null;
}) {
  const { data: session } = useSession();
  if (!session?.session?.id) return null;
  if (containerId && containerId.startsWith("dmr:")) {
    return (
      <div className="mt-6 rounded-md border border-dashed border-[var(--color-border)] p-4 text-xs text-[var(--color-muted)]">
        DMR models share the system-wide model-runner container; per-project logs not available. Use{" "}
        <code className="font-mono">docker logs -f docker-model-runner</code> on the host to tail
        all DMR activity.
      </div>
    );
  }
  return (
    <div className="mt-6">
      <LogStream projectId={projectId} sessionId={session.session.id} />
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-[var(--color-muted)]">{label}</div>
      <div className={`mt-1 ${mono ? "break-all font-mono text-xs" : "text-sm"}`}>{value}</div>
    </div>
  );
}

function runtimeLabel(kind: string) {
  if (kind === "ollama") return "Ollama";
  if (kind === "docker-model-runner") return "Docker Model Runner";
  if (kind === "llama-cpp") return "llama.cpp";
  return kind;
}
