"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { useSession } from "@/lib/auth-client";
import { LogStream } from "@/components/log-stream";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Copy,
  Cpu,
  MemoryStick,
  Play,
  Square,
  Terminal,
  Trash2,
  type LucideIcon,
} from "lucide-react";

function formatBytes(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i += 1;
  }
  const decimals = i === 0 || size >= 10 ? 0 : 1;
  return `${size.toFixed(decimals)} ${units[i] ?? "TiB"}`;
}

function formatPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  const decimals = value > 0 && value < 10 ? 1 : 0;
  return `${value.toFixed(decimals)}%`;
}

function ResourceMeter({
  icon: Icon,
  label,
  value,
  detail,
  percent,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  percent: number;
}) {
  const width = Number.isFinite(percent) ? Math.max(0, Math.min(percent, 100)) : 0;
  return (
    <div className="rounded-md border border-[var(--color-border)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-[var(--color-muted)]">{label}</div>
          <div className="mt-1 text-2xl font-semibold">{value}</div>
          <div className="mt-1 truncate text-xs text-[var(--color-muted)]">{detail}</div>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-white/5 text-[var(--color-info)]">
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/5">
        <div
          className="h-full rounded-full bg-[var(--color-info)] transition-[width]"
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

export default function SandboxDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.projects.getById.useQuery(
    { id, kind: "sandbox" },
    {
      refetchInterval: (q) =>
        q.state.data?.kind === "sandbox" && q.state.data.status === "creating" ? 2000 : false,
    },
  );
  const statsQuery = trpc.sandbox.stats.useQuery(
    { projectId: id },
    {
      enabled: data?.kind === "sandbox" && data.status === "running",
      refetchInterval: 2000,
    },
  );

  const start = trpc.sandbox.start.useMutation({
    onSuccess: () => utils.projects.getById.invalidate({ id, kind: "sandbox" }),
  });
  const stop = trpc.sandbox.stop.useMutation({
    onSuccess: () => utils.projects.getById.invalidate({ id, kind: "sandbox" }),
  });
  const destroy = trpc.sandbox.destroy.useMutation({
    onSuccess: () => router.push("/dashboard"),
  });

  const [copied, setCopied] = useState(false);

  if (isLoading || !data) {
    return <div className="text-sm text-[var(--color-muted)]">Loading…</div>;
  }
  if (data.kind !== "sandbox") return null;
  const p = data;

  const isRunning = p.status === "running";
  const isStopped = p.status === "stopped";
  const isDestroyed = p.status === "destroyed";
  const canStart = isStopped;
  const canStop = isRunning;
  const canDestroy = !isDestroyed;
  const stats = statsQuery.data;
  const statsDetail = stats
    ? `Updated ${new Date(stats.readAt).toLocaleTimeString()}`
    : statsQuery.error
      ? "Stats unavailable"
      : "Collecting";
  const memoryDetail = stats
    ? `${formatPercent(stats.memoryPercent)} of ${formatBytes(stats.memoryLimitBytes)}`
    : statsDetail;

  const sshCmd =
    p.sshHost && p.containerPort
      ? `chmod 600 <private-key-file> && ssh -o StrictHostKeyChecking=accept-new -p ${p.containerPort} -i <private-key-file> ${p.sshUser ?? "root"}@${p.sshHost}`
      : null;

  async function copySsh() {
    if (!sshCmd) return;
    await navigator.clipboard.writeText(sshCmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{p.name}</h1>
          <p className="text-sm text-[var(--color-muted)]">
            {p.distro} · <span className="font-mono">{p.slug}</span>
          </p>
        </div>
        <StatusBadge status={p.status} />
      </div>

      {p.description ? (
        <p className="mb-6 text-sm text-[var(--color-muted)]">{p.description}</p>
      ) : null}

      <div className="mb-6 grid grid-cols-1 gap-4 rounded-md border border-[var(--color-border)] p-4 text-sm md:grid-cols-2">
        <div className="md:col-span-2">
          <div className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
            SSH command
          </div>
          {isRunning && sshCmd ? (
            <div className="mt-1 flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-white/5 px-2 py-1 font-mono text-xs">
                {sshCmd}
              </code>
              <Button size="sm" variant="ghost" onClick={copySsh}>
                <Copy className="h-3 w-3" />
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          ) : (
            <div className="mt-1 text-[var(--color-muted)]">
              {isStopped ? "Container stopped — start to get port" : "—"}
            </div>
          )}
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            Replace <code>&lt;private-key-file&gt;</code> with the .pem you downloaded at create
            time. The server does not store the private key.
          </p>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-muted)]">Volume</div>
          <div className="mt-1 break-all font-mono text-xs">{p.volumeName}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-muted)]">Created</div>
          <div className="mt-1 text-xs">{new Date(p.createdAt as any).toLocaleString()}</div>
        </div>
      </div>

      {isRunning ? (
        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          <ResourceMeter
            icon={Cpu}
            label="Docker CPU"
            value={formatPercent(stats?.cpuPercent)}
            detail={statsDetail}
            percent={stats?.cpuPercent ?? 0}
          />
          <ResourceMeter
            icon={MemoryStick}
            label="Docker RAM"
            value={formatBytes(stats?.memoryUsageBytes)}
            detail={memoryDetail}
            percent={stats?.memoryPercent ?? 0}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {canStart ? (
          <Button
            variant="outline"
            disabled={start.isPending}
            onClick={() => start.mutate({ projectId: p.id })}
          >
            <Play className="h-3.5 w-3.5" />
            {start.isPending ? "Starting…" : "Start"}
          </Button>
        ) : null}

        {canStop ? (
          <Button
            variant="outline"
            disabled={stop.isPending}
            onClick={() => stop.mutate({ projectId: p.id })}
          >
            <Square className="h-3.5 w-3.5" />
            {stop.isPending ? "Stopping…" : "Stop"}
          </Button>
        ) : null}

        {canDestroy ? (
          <Button
            variant="destructive"
            disabled={destroy.isPending}
            onClick={() => {
              if (confirm("Destroy sandbox and volume? This cannot be undone.")) {
                destroy.mutate({ projectId: p.id });
              }
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {destroy.isPending ? "Destroying…" : "Destroy"}
          </Button>
        ) : null}

        {isRunning && sshCmd ? (
          <div className="ml-auto inline-flex items-center text-xs text-[var(--color-muted)]">
            <Terminal className="mr-1.5 h-3.5 w-3.5" /> Connect via terminal
          </div>
        ) : null}
      </div>

      {start.error ? (
        <div className="mt-3 text-sm text-[var(--color-error)]">{start.error.message}</div>
      ) : null}
      {stop.error ? (
        <div className="mt-3 text-sm text-[var(--color-error)]">{stop.error.message}</div>
      ) : null}

      <ProjectLogs projectId={p.id} />
    </div>
  );
}

function ProjectLogs({ projectId }: { projectId: string }) {
  const { data: session } = useSession();
  if (!session?.session?.id) return null;
  return (
    <div className="mt-6">
      <LogStream projectId={projectId} sessionId={session.session.id} />
    </div>
  );
}
