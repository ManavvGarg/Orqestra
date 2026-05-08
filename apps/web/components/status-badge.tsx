import { cn } from "@/lib/utils";

type Status =
  | "running"
  | "stopped"
  | "creating"
  | "destroyed"
  | "errored"
  | "pending"
  | "pulling";

const map: Record<Status, { label: string; cls: string }> = {
  running: { label: "Running", cls: "bg-[var(--color-success)]/15 text-[var(--color-success)]" },
  stopped: { label: "Stopped", cls: "bg-[var(--color-warn)]/15 text-[var(--color-warn)]" },
  creating: { label: "Creating", cls: "bg-[var(--color-info)]/15 text-[var(--color-info)]" },
  destroyed: { label: "Destroyed", cls: "bg-white/5 text-[var(--color-muted)]" },
  errored: { label: "Errored", cls: "bg-[var(--color-error)]/15 text-[var(--color-error)]" },
  pending: { label: "Pending", cls: "bg-white/5 text-[var(--color-muted)]" },
  pulling: { label: "Pulling", cls: "bg-[var(--color-info)]/15 text-[var(--color-info)]" },
};

export function StatusBadge({ status }: { status: Status }) {
  const m = map[status] ?? { label: status, cls: "bg-white/5" };
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", m.cls)}>
      <span className="mr-1 h-1.5 w-1.5 rounded-full bg-current" />
      {m.label}
    </span>
  );
}
