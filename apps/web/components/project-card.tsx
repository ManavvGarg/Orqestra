"use client";

import Link from "next/link";
import { StatusBadge } from "./status-badge";
import { Button } from "./ui/button";
import { Check, ExternalLink, Tag, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface ProjectTag {
  id: string;
  name: string;
  color: string;
}

interface JupyterRow {
  kind: "jupyter";
  id: string;
  name: string;
  slug: string;
  jobType: string;
  status: "running" | "stopped" | "creating" | "destroyed" | "errored";
  containerUrl: string | null;
  createdAt: Date | string;
  tags?: ProjectTag[];
}

interface ModelRow {
  kind: "model";
  id: string;
  name: string;
  slug: string;
  status: "pending" | "pulling" | "running" | "stopped" | "destroyed" | "errored";
  apiUrl: string | null;
  runtime: "ollama" | "docker-model-runner" | "llama-cpp";
  createdAt: Date | string;
  tags?: ProjectTag[];
}

interface SandboxRow {
  kind: "sandbox";
  id: string;
  name: string;
  slug: string;
  distro: string;
  status: "running" | "stopped" | "creating" | "destroyed" | "errored";
  createdAt: Date | string;
  tags?: ProjectTag[];
}

type Project = JupyterRow | ModelRow | SandboxRow;

export function ProjectCard({
  project,
  availableTags = [],
  onAddTag,
  onRemoveTag,
  tagsDisabled = false,
  selectMode = false,
  selected = false,
  onToggleSelect,
}: {
  project: Project;
  availableTags?: ProjectTag[];
  onAddTag?: (tagId: string) => void;
  onRemoveTag?: (tagId: string) => void;
  tagsDisabled?: boolean;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const detailHref =
    project.kind === "jupyter"
      ? `/jupyter/${project.id}`
      : project.kind === "sandbox"
        ? `/sandbox/${project.id}`
        : `/models/${project.id}`;
  const externalUrl =
    project.kind === "jupyter"
      ? project.containerUrl
      : project.kind === "model"
        ? project.apiUrl
        : null;
  const status = project.status;
  const created =
    typeof project.createdAt === "string"
      ? new Date(project.createdAt)
      : project.createdAt;
  const projectTags = project.tags ?? [];
  const assignedTagIds = new Set(projectTags.map((tag) => tag.id));
  const assignableTags = availableTags.filter((tag) => !assignedTagIds.has(tag.id));

  return (
    <div
      className={cn(
        "relative rounded-lg border bg-white/[0.02] p-4 transition-colors",
        selected
          ? "border-[var(--color-error)] ring-2 ring-[var(--color-error)]/40"
          : "border-[var(--color-border)]",
        selectMode && "cursor-pointer hover:bg-white/[0.04]",
      )}
      onClick={selectMode ? onToggleSelect : undefined}
    >
      {selectMode ? (
        <div
          className={cn(
            "absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded border",
            selected
              ? "border-[var(--color-error)] bg-[var(--color-error)] text-white"
              : "border-[var(--color-border)] bg-black/40",
          )}
        >
          {selected ? <Check className="h-3 w-3" /> : null}
        </div>
      ) : null}
      <div className={cn(selectMode && "pointer-events-none select-none opacity-90")}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <Link href={detailHref as any} className="text-sm font-semibold hover:underline">
            {project.name}
          </Link>
          <div className="mt-0.5 text-xs text-[var(--color-muted)]">
            {project.kind === "jupyter"
              ? `Jupyter · ${project.jobType}`
              : project.kind === "sandbox"
                ? `Sandbox · ${project.distro}`
                : "Static hosting"}
          </div>
        </div>
        <StatusBadge status={status} />
      </div>

      <div className="mt-3 text-xs text-[var(--color-muted)]">
        {project.slug} · {created.toLocaleDateString()}
      </div>

      <div className="mt-4 flex min-h-8 flex-wrap items-center gap-1.5">
        {projectTags.length === 0 ? (
          <span className="text-xs text-[var(--color-muted)]">Untagged</span>
        ) : (
          projectTags.map((tag) => (
            <span
              key={tag.id}
              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
              style={{ borderColor: tag.color, color: tag.color, backgroundColor: `${tag.color}1f` }}
            >
              {tag.name}
              {onRemoveTag ? (
                <button
                  type="button"
                  className="rounded-full p-0.5 hover:bg-white/10"
                  disabled={tagsDisabled}
                  onClick={() => onRemoveTag(tag.id)}
                  aria-label={`Remove ${tag.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              ) : null}
            </span>
          ))
        )}
      </div>

      <div className="mt-4 flex gap-2">
        {externalUrl ? (
          <Button asChild size="sm" variant="outline">
            <a href={externalUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3 w-3" />
              Open
            </a>
          </Button>
        ) : null}
        <Button asChild size="sm" variant="ghost">
          <Link href={detailHref as any}>Manage</Link>
        </Button>
        {onAddTag && assignableTags.length > 0 ? (
          <label className="relative inline-flex h-8 items-center">
            <Tag className="pointer-events-none absolute left-2 h-3 w-3 text-[var(--color-muted)]" />
            <select
              value=""
              disabled={tagsDisabled}
              className="h-8 rounded-md border border-[var(--color-border)] bg-transparent pl-7 pr-2 text-xs text-[var(--color-fg)] outline-none hover:bg-white/5 disabled:opacity-50"
              onChange={(event) => {
                if (event.currentTarget.value) onAddTag(event.currentTarget.value);
              }}
              aria-label={`Add tag to ${project.name}`}
            >
              <option value="">Tag</option>
              {assignableTags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      </div>
    </div>
  );
}
