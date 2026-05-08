import type { LucideIcon } from "lucide-react";

export function formatBytes(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 || size >= 10 ? 0 : 1;
  return `${size.toFixed(decimals)} ${units[unitIndex] ?? "TiB"}`;
}

export function formatPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  const decimals = value > 0 && value < 10 ? 1 : 0;
  return `${value.toFixed(decimals)}%`;
}

export function ResourceMeter({
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
