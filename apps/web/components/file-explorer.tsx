"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ChevronRight,
  Download,
  File as FileIcon,
  Folder,
  FolderOpen,
  Home,
  RefreshCw,
} from "lucide-react";

const ROOT = "/home/jovyan";

interface Props {
  projectId: string;
}

export function FileExplorer({ projectId }: Props) {
  const [path, setPath] = useState(`${ROOT}/work`);
  const { data, isLoading, error, refetch, isFetching } = trpc.files.list.useQuery(
    { projectId, path },
    { retry: false },
  );

  const segments = path === "/" ? [] : path.split("/").filter(Boolean);

  function navigate(newPath: string) {
    setPath(newPath);
  }

  function downloadUrl(filePath: string) {
    const base = process.env.NEXT_PUBLIC_API_URL ?? "";
    return `${base}/files/jupyter/${projectId}/download?path=${encodeURIComponent(filePath)}`;
  }

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-white/[0.02]">
      <div className="flex items-center gap-1 border-b border-[var(--color-border)] px-3 py-2 text-xs">
        <button
          onClick={() => navigate(`${ROOT}/work`)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/5"
        >
          <Home className="h-3 w-3" />
        </button>
        {segments.map((seg, i) => {
          const target = "/" + segments.slice(0, i + 1).join("/");
          return (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight className="h-3 w-3 text-[var(--color-muted)]" />
              <button
                onClick={() => navigate(target)}
                className="rounded px-1.5 py-0.5 font-mono hover:bg-white/5"
              >
                {seg}
              </button>
            </span>
          );
        })}
        <span className="ml-auto">
          <Button
            size="sm"
            variant="ghost"
            disabled={isFetching}
            onClick={() => refetch()}
            className="h-6"
          >
            <RefreshCw className={cn("h-3 w-3", isFetching && "animate-spin")} />
          </Button>
        </span>
      </div>

      {error ? (
        <div className="p-4 text-sm text-[var(--color-error)]">{error.message}</div>
      ) : isLoading ? (
        <div className="p-4 text-sm text-[var(--color-muted)]">Loading…</div>
      ) : !data ? null : (data.entries ?? []).length === 0 ? (
        <div className="p-8 text-center text-sm text-[var(--color-muted)]">
          (empty directory)
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {sortEntries(data.entries ?? []).map((e) => {
            const childPath = path === "/" ? `/${e.name}` : `${path}/${e.name}`;
            const isDir = e.type === "dir";
            return (
              <li key={e.name} className="flex items-center gap-2 px-3 py-2 text-sm">
                {isDir ? (
                  <button
                    onClick={() => navigate(childPath)}
                    className="flex flex-1 items-center gap-2 hover:underline"
                  >
                    <Folder className="h-4 w-4 text-[var(--color-info)]" />
                    <span>{e.name}</span>
                  </button>
                ) : (
                  <span className="flex flex-1 items-center gap-2">
                    <FileIcon className="h-4 w-4 text-[var(--color-muted)]" />
                    <span>{e.name}</span>
                    {e.type === "symlink" ? (
                      <span className="text-xs text-[var(--color-muted)]">(symlink)</span>
                    ) : null}
                  </span>
                )}
                <span className="hidden text-xs text-[var(--color-muted)] sm:inline">
                  {isDir ? "—" : formatBytes(e.size)}
                </span>
                <span className="hidden text-xs text-[var(--color-muted)] md:inline">
                  {formatTime(e.modifiedAt)}
                </span>
                <a
                  href={downloadUrl(childPath)}
                  className="rounded p-1.5 hover:bg-white/5"
                  title={isDir ? "Download as .tar" : "Download file"}
                >
                  <Download className="h-3.5 w-3.5" />
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function sortEntries<T extends { name: string; type: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    if (a.type === "dir" && b.type !== "dir") return -1;
    if (a.type !== "dir" && b.type === "dir") return 1;
    return a.name.localeCompare(b.name);
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatTime(unix: number): string {
  if (!unix) return "";
  return new Date(unix * 1000).toLocaleString();
}
