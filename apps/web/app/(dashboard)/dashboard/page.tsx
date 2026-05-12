"use client";

import Link from "next/link";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { ProjectCard } from "@/components/project-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Boxes,
  CheckSquare,
  FileCode2,
  Network,
  Square,
  Tag,
  Terminal,
  Trash2,
} from "lucide-react";

type ProjectTag = {
  id: string;
  name: string;
  color: string;
};

type ProjectRow = {
  kind: "jupyter" | "model" | "sandbox" | "swarm";
  id: string;
  name: string;
  slug: string;
  createdAt: Date | string;
  tags?: ProjectTag[];
  status?:
    | "running"
    | "stopped"
    | "creating"
    | "destroyed"
    | "errored"
    | "pending"
    | "pulling";
};

type CategoryId =
  | "all"
  | "jupyter"
  | "model"
  | "sandbox"
  | "swarm"
  | "active"
  | "attention"
  | "destroyed";
type TagFilter = string | "untagged" | null;

function createdTime(project: ProjectRow) {
  return new Date(project.createdAt as unknown as string).getTime();
}

function matchesCategory(project: ProjectRow, category: CategoryId) {
  if (category === "destroyed") return project.status === "destroyed";
  // Every other view hides destroyed projects.
  if (project.status === "destroyed") return false;
  switch (category) {
    case "jupyter":
      return project.kind === "jupyter";
    case "model":
      return project.kind === "model";
    case "sandbox":
      return project.kind === "sandbox";
    case "swarm":
      return project.kind === "swarm";
    case "active":
      return project.status === "running" || project.status === "pulling";
    case "attention":
      return project.status === "errored";
    default:
      return true;
  }
}

export default function DashboardPage() {
  const utils = trpc.useUtils();
  const [category, setCategory] = useState<CategoryId>("all");
  const [tagFilter, setTagFilter] = useState<TagFilter>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const { data, isLoading } = trpc.projects.list.useQuery();
  const { data: tags = [] } = trpc.tags.list.useQuery();
  const refreshProjects = () => utils.projects.list.invalidate();
  const assignTag = trpc.tags.assign.useMutation({ onSuccess: refreshProjects });
  const unassignTag = trpc.tags.unassign.useMutation({ onSuccess: refreshProjects });
  const destroyJupyter = trpc.jupyter.destroy.useMutation();
  const destroyModel = trpc.models.destroy.useMutation();
  const destroySandbox = trpc.sandbox.destroy.useMutation();
  const destroySwarm = trpc.agenthive.delete.useMutation();

  const projectKey = (p: { kind: string; id: string }) => `${p.kind}:${p.id}`;
  const toggleSelected = (key: string) =>
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  function exitSelectMode() {
    setSelectMode(false);
    setSelectedKeys(new Set());
    setShowDeleteModal(false);
    setConfirmText("");
    setBulkError(null);
  }

  async function runBulkDelete() {
    setBulkBusy(true);
    setBulkError(null);
    const failures: string[] = [];
    for (const key of Array.from(selectedKeys)) {
      const [kind, id] = key.split(":");
      try {
        if (kind === "jupyter") {
          await destroyJupyter.mutateAsync({ projectId: id! });
        } else if (kind === "model") {
          await destroyModel.mutateAsync({ projectId: id! });
        } else if (kind === "sandbox") {
          await destroySandbox.mutateAsync({ projectId: id! });
        } else if (kind === "swarm") {
          await destroySwarm.mutateAsync({ swarmId: id! });  // full delete in bulk path
        }
      } catch (e) {
        failures.push(`${kind}:${id} → ${e instanceof Error ? e.message : "failed"}`);
      }
    }
    setBulkBusy(false);
    if (failures.length > 0) {
      setBulkError(failures.join("\n"));
    } else {
      exitSelectMode();
    }
    await refreshProjects();
  }

  if (isLoading) {
    return <div className="text-sm text-[var(--color-muted)]">Loading…</div>;
  }

  const all = (
    [
      ...(data?.jupyter ?? []),
      ...(data?.model ?? []),
      ...(data?.sandbox ?? []),
      ...(data?.swarm ?? []),
    ] as ProjectRow[]
  ).sort((a, b) => createdTime(b) - createdTime(a));
  const categoryProjects = all.filter((project) => matchesCategory(project, category));
  const visibleProjects =
    tagFilter === "untagged"
      ? categoryProjects.filter((project) => (project.tags ?? []).length === 0)
      : tagFilter
        ? categoryProjects.filter((project) => (project.tags ?? []).some((tag) => tag.id === tagFilter))
        : categoryProjects;
  const selectedTag = tagFilter && tagFilter !== "untagged" ? tags.find((tag) => tag.id === tagFilter) : null;
  const categoryItems: Array<{ id: CategoryId; label: string; count: number; icon: React.ReactNode }> = [
    {
      id: "all",
      label: "All",
      count: all.filter((p) => matchesCategory(p, "all")).length,
      icon: <Boxes className="h-3.5 w-3.5" />,
    },
    {
      id: "jupyter",
      label: "Jupyter",
      count: all.filter((p) => matchesCategory(p, "jupyter")).length,
      icon: <FileCode2 className="h-3.5 w-3.5" />,
    },
    {
      id: "model",
      label: "Models",
      count: all.filter((p) => matchesCategory(p, "model")).length,
      icon: <Boxes className="h-3.5 w-3.5" />,
    },
    {
      id: "sandbox",
      label: "Sandbox",
      count: all.filter((p) => matchesCategory(p, "sandbox")).length,
      icon: <Terminal className="h-3.5 w-3.5" />,
    },
    {
      id: "swarm",
      label: "Swarms",
      count: all.filter((p) => matchesCategory(p, "swarm")).length,
      icon: <Network className="h-3.5 w-3.5" />,
    },
    {
      id: "active",
      label: "Active",
      count: all.filter((project) => matchesCategory(project, "active")).length,
      icon: <Boxes className="h-3.5 w-3.5" />,
    },
    {
      id: "attention",
      label: "Attention",
      count: all.filter((project) => matchesCategory(project, "attention")).length,
      icon: <Boxes className="h-3.5 w-3.5" />,
    },
    {
      id: "destroyed",
      label: "Destroyed",
      count: all.filter((project) => project.status === "destroyed").length,
      icon: <Trash2 className="h-3.5 w-3.5" />,
    },
  ];
  const untaggedCount = categoryProjects.filter((project) => (project.tags ?? []).length === 0).length;
  const tagSections =
    tagFilter === "untagged"
      ? [{ id: "untagged", title: "Untagged", projects: visibleProjects }]
      : selectedTag
        ? [{ id: selectedTag.id, title: selectedTag.name, projects: visibleProjects }]
        : tags.length > 0
          ? [
              ...tags.map((tag) => ({
                id: tag.id,
                title: tag.name,
                projects: categoryProjects.filter((project) =>
                  (project.tags ?? []).some((projectTag) => projectTag.id === tag.id),
                ),
              })),
              {
                id: "untagged",
                title: "Untagged",
                projects: categoryProjects.filter((project) => (project.tags ?? []).length === 0),
              },
            ].filter((section) => section.projects.length > 0)
          : [
              {
                id: "jupyter",
                title: "Jupyter notebooks",
                projects: categoryProjects.filter((project) => project.kind === "jupyter"),
              },
              {
                id: "model",
                title: "Hosted models",
                projects: categoryProjects.filter((project) => project.kind === "model"),
              },
            ].filter((section) => section.projects.length > 0);
  const tagMutationPending = assignTag.isPending || unassignTag.isPending;

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {visibleProjects.length} shown from {all.length} total
          </p>
        </div>
        <div className="flex gap-2">
          {selectMode ? (
            <>
              <span className="self-center text-sm text-[var(--color-muted)]">
                {selectedKeys.size} selected
              </span>
              <Button
                size="sm"
                variant="destructive"
                disabled={selectedKeys.size === 0}
                onClick={() => setShowDeleteModal(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={exitSelectMode}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSelectMode(true)}
                disabled={all.length === 0}
              >
                <CheckSquare className="h-3.5 w-3.5" />
                Select
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href={"/jupyter/new" as any}>+ Jupyter</Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href={"/sandbox/new" as any}>+ Sandbox</Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href={"/swarms/new" as any}>+ Swarm</Link>
              </Button>
              <Button asChild size="sm">
                <Link href={"/models/new" as any}>+ Model</Link>
              </Button>
            </>
          )}
        </div>
      </header>

      {showDeleteModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-bg,#0a0a0a)] p-5 shadow-xl">
            <h2 className="text-lg font-semibold">Delete {selectedKeys.size} project{selectedKeys.size === 1 ? "" : "s"}?</h2>
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              Containers will be stopped + removed. Volumes for Jupyter projects will be deleted permanently.
            </p>
            <p className="mt-3 text-sm">
              Type <code className="rounded bg-white/10 px-1 font-mono">delete</code> to confirm:
            </p>
            <Input
              autoFocus
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="delete"
              className="mt-2"
            />
            {bulkError ? (
              <pre className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap rounded border border-[var(--color-error)]/40 bg-[var(--color-error)]/10 p-2 text-xs text-[var(--color-error)]">
                {bulkError}
              </pre>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowDeleteModal(false);
                  setConfirmText("");
                  setBulkError(null);
                }}
                disabled={bulkBusy}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={confirmText.trim().toLowerCase() !== "delete" || bulkBusy}
                onClick={runBulkDelete}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {bulkBusy ? "Deleting…" : `Delete ${selectedKeys.size}`}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="mb-5 flex flex-wrap gap-2">
        {categoryItems.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setCategory(item.id)}
            className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm ${
              category === item.id
                ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                : "border-[var(--color-border)] hover:bg-white/5"
            }`}
          >
            {item.icon}
            {item.label}
            <span className="text-xs opacity-70">{item.count}</span>
          </button>
        ))}
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setTagFilter(null)}
          className={`inline-flex h-8 items-center rounded-full border px-3 text-xs ${
            tagFilter === null
              ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
              : "border-[var(--color-border)] hover:bg-white/5"
          }`}
        >
          All tags
        </button>
        {tags.map((tag) => {
          const count = categoryProjects.filter((project) =>
            (project.tags ?? []).some((projectTag) => projectTag.id === tag.id),
          ).length;
          return (
            <button
              key={tag.id}
              type="button"
              onClick={() => setTagFilter(tag.id)}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs hover:bg-white/5"
              style={
                tagFilter === tag.id
                  ? { borderColor: tag.color, backgroundColor: `${tag.color}1f`, color: tag.color }
                  : { borderColor: "var(--color-border)" }
              }
            >
              <Tag className="h-3 w-3" />
              {tag.name}
              <span className="opacity-70">{count}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setTagFilter("untagged")}
          className={`inline-flex h-8 items-center rounded-full border px-3 text-xs ${
            tagFilter === "untagged"
              ? "border-[var(--color-accent)] bg-white/10"
              : "border-[var(--color-border)] hover:bg-white/5"
          }`}
        >
          Untagged {untaggedCount}
        </button>
        <Button asChild variant="ghost" size="sm">
          <Link href={"/tags" as any}>
            <Tag className="h-3 w-3" />
            Manage tags
          </Link>
        </Button>
      </div>

      {all.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] p-12 text-center text-sm text-[var(--color-muted)]">
          No projects yet. Spin up your first one above.
        </div>
      ) : visibleProjects.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] p-12 text-center text-sm text-[var(--color-muted)]">
          No projects match this view.
        </div>
      ) : (
        <div className="space-y-8">
          {tagSections.map((section) => (
            <section key={section.id}>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                  {section.title}
                </h2>
                <span className="text-xs text-[var(--color-muted)]">{section.projects.length}</span>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                {section.projects.map((p) => {
                  const k = projectKey(p);
                  return (
                    <ProjectCard
                      key={`${section.id}-${p.kind}-${p.id}`}
                      project={p as any}
                      availableTags={tags}
                      tagsDisabled={tagMutationPending}
                      selectMode={selectMode}
                      selected={selectedKeys.has(k)}
                      onToggleSelect={() => toggleSelected(k)}
                      onAddTag={(tagId) =>
                        assignTag.mutate({ projectId: p.id, projectKind: p.kind, tagId })
                      }
                      onRemoveTag={(tagId) =>
                        unassignTag.mutate({ projectId: p.id, projectKind: p.kind, tagId })
                      }
                    />
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
