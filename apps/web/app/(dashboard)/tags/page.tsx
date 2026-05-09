"use client";

import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Save, Tag, Trash2 } from "lucide-react";

type ProjectTag = {
  id: string;
  name: string;
  color: string;
};

function TagRow({
  tag,
  count,
  onSave,
  onDelete,
  disabled,
}: {
  tag: ProjectTag;
  count: number;
  onSave: (input: { tagId: string; name: string; color: string }) => void;
  onDelete: (tagId: string) => void;
  disabled: boolean;
}) {
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState(tag.color);
  const hasChanges = name.trim() !== tag.name || color !== tag.color;

  useEffect(() => {
    setName(tag.name);
    setColor(tag.color);
  }, [tag.color, tag.name]);

  return (
    <div className="grid grid-cols-1 gap-3 rounded-md border border-[var(--color-border)] p-4 md:grid-cols-[1fr_6rem_auto] md:items-center">
      <div className="flex items-center gap-3">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
          style={{ borderColor: color, color, backgroundColor: `${color}1f` }}
        >
          <Tag className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <Input value={name} onChange={(event) => setName(event.target.value)} disabled={disabled} />
          <div className="mt-1 text-xs text-[var(--color-muted)]">{count} projects</div>
        </div>
      </div>
      <Input
        type="color"
        value={color}
        onChange={(event) => setColor(event.target.value)}
        disabled={disabled}
        className="px-1 py-1"
        aria-label={`${tag.name} color`}
      />
      <div className="flex gap-2 md:justify-end">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || !hasChanges || name.trim().length === 0}
          onClick={() => onSave({ tagId: tag.id, name: name.trim(), color })}
        >
          <Save className="h-3.5 w-3.5" />
          Save
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={disabled}
          onClick={() => {
            if (confirm(`Delete tag "${tag.name}"?`)) onDelete(tag.id);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </Button>
      </div>
    </div>
  );
}

export default function TagsPage() {
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#6366f1");
  const tagsQuery = trpc.tags.list.useQuery();
  const projectsQuery = trpc.projects.list.useQuery();

  const invalidateTags = async () => {
    await Promise.all([utils.tags.list.invalidate(), utils.projects.list.invalidate()]);
  };
  const create = trpc.tags.create.useMutation({
    onSuccess: async () => {
      setName("");
      setColor("#6366f1");
      await invalidateTags();
    },
  });
  const update = trpc.tags.update.useMutation({ onSuccess: invalidateTags });
  const remove = trpc.tags.remove.useMutation({ onSuccess: invalidateTags });

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const projects = [...(projectsQuery.data?.jupyter ?? []), ...(projectsQuery.data?.model ?? [])];
    for (const project of projects) {
      for (const tag of project.tags ?? []) {
        counts.set(tag.id, (counts.get(tag.id) ?? 0) + 1);
      }
    }
    return counts;
  }, [projectsQuery.data]);
  const pending = create.isPending || update.isPending || remove.isPending;

  return (
    <div className="max-w-3xl">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Tags</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Create project labels for dashboard grouping and filtering.
        </p>
      </header>

      <form
        className="mb-6 grid grid-cols-1 gap-3 rounded-md border border-[var(--color-border)] p-4 md:grid-cols-[1fr_5rem_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) create.mutate({ name: name.trim(), color });
        }}
      >
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Tag name"
          disabled={pending}
        />
        <Input
          type="color"
          value={color}
          onChange={(event) => setColor(event.target.value)}
          disabled={pending}
          className="px-1 py-1"
          aria-label="Tag color"
        />
        <Button type="submit" disabled={pending || name.trim().length === 0}>
          <Tag className="h-3.5 w-3.5" />
          Create
        </Button>
      </form>

      {tagsQuery.isLoading ? (
        <div className="text-sm text-[var(--color-muted)]">Loading...</div>
      ) : (tagsQuery.data ?? []).length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] p-10 text-center text-sm text-[var(--color-muted)]">
          No tags yet.
        </div>
      ) : (
        <div className="space-y-3">
          {(tagsQuery.data ?? []).map((tag) => (
            <TagRow
              key={tag.id}
              tag={tag}
              count={tagCounts.get(tag.id) ?? 0}
              disabled={pending}
              onSave={(input) => update.mutate(input)}
              onDelete={(tagId) => remove.mutate({ tagId })}
            />
          ))}
        </div>
      )}

      {create.error ? (
        <div className="mt-3 text-sm text-[var(--color-error)]">{create.error.message}</div>
      ) : null}
      {update.error ? (
        <div className="mt-3 text-sm text-[var(--color-error)]">{update.error.message}</div>
      ) : null}
      {remove.error ? (
        <div className="mt-3 text-sm text-[var(--color-error)]">{remove.error.message}</div>
      ) : null}
    </div>
  );
}
