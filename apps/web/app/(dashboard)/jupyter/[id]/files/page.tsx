"use client";

import { use } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc";
import { FileExplorer } from "@/components/file-explorer";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

export default function JupyterFilesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, isLoading } = trpc.projects.getById.useQuery({ id, kind: "jupyter" });

  if (isLoading || !data) {
    return <div className="text-sm text-[var(--color-muted)]">Loading…</div>;
  }
  if (data.kind !== "jupyter") return null;
  const p = data;

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <Button asChild variant="ghost" size="sm" className="-ml-3 mb-2">
            <Link href={`/jupyter/${id}` as any}>
              <ArrowLeft className="h-3.5 w-3.5" /> Back to project
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold">{p.name} · Files</h1>
          <p className="text-sm text-[var(--color-muted)]">
            Browse and download files from the container volume.
          </p>
        </div>
        <StatusBadge status={p.status} />
      </div>

      {p.status !== "running" ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] p-6 text-sm text-[var(--color-muted)]">
          Container is <strong>{p.status}</strong>. Start it to browse files.
        </div>
      ) : (
        <FileExplorer projectId={p.id} />
      )}
    </div>
  );
}
