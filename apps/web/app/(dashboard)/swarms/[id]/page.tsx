"use client";

import { use, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { useSession } from "@/lib/auth-client";
import { AgentMessageStream } from "@/components/agent-message-stream";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Play, Plus, Square, Trash2 } from "lucide-react";

export default function SwarmDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const utils = trpc.useUtils();
  const { data: session } = useSession();

  const swarmQ = trpc.projects.getById.useQuery(
    { id, kind: "swarm" },
    {
      refetchInterval: (q) =>
        q.state.data?.kind === "swarm" && q.state.data.status === "creating" ? 2000 : false,
    },
  );

  const threadsQ = trpc.agenthive.listThreads.useQuery({ swarmId: id }, { enabled: !!swarmQ.data });
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  useEffect(() => {
    if (!activeThreadId && threadsQ.data && threadsQ.data.length > 0) {
      setActiveThreadId(threadsQ.data[0]!.id);
    }
  }, [threadsQ.data, activeThreadId]);

  const messagesQ = trpc.agenthive.listMessages.useQuery(
    { threadId: activeThreadId ?? "" },
    { enabled: !!activeThreadId, refetchInterval: 2000 },
  );

  const createThread = trpc.agenthive.createThread.useMutation({
    onSuccess: (t) => {
      setActiveThreadId(t.id);
      utils.agenthive.listThreads.invalidate({ swarmId: id });
    },
  });
  const startRun = trpc.agenthive.startRun.useMutation({
    onSuccess: (run) => {
      setActiveRunId(run.id);
      utils.agenthive.listMessages.invalidate({ threadId: run.threadId });
    },
  });
  const start = trpc.agenthive.start.useMutation({
    onSuccess: () => utils.projects.getById.invalidate({ id, kind: "swarm" }),
  });
  const stop = trpc.agenthive.stop.useMutation({
    onSuccess: () => utils.projects.getById.invalidate({ id, kind: "swarm" }),
  });
  const destroy = trpc.agenthive.destroy.useMutation({
    onSuccess: () => utils.projects.getById.invalidate({ id, kind: "swarm" }),
  });
  const deleteSwarm = trpc.agenthive.delete.useMutation({
    onSuccess: () => router.push("/dashboard"),
  });

  const [draft, setDraft] = useState("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const data = swarmQ.data;
  const isRunning = data?.kind === "swarm" && data.status === "running";

  const agentList = useMemo(() => {
    if (data?.kind !== "swarm") return [] as string[];
    return data.spec.agents.map((a) => a.name);
  }, [data]);

  if (swarmQ.isLoading || !data) {
    return <div className="text-sm text-[var(--color-muted)]">Loading…</div>;
  }
  if (data.kind !== "swarm") return null;

  function sendUserMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!activeThreadId || !draft.trim()) return;
    startRun.mutate({ threadId: activeThreadId, userMessage: draft });
    setDraft("");
  }

  return (
    <div className="max-w-4xl">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{data.name}</h1>
          <p className="text-sm text-[var(--color-muted)]">
            Swarm · <span className="font-mono">{data.slug}</span> · {agentList.length} agents
          </p>
        </div>
        <StatusBadge status={data.status} />
      </div>

      {data.description ? (
        <p className="mb-6 text-sm text-[var(--color-muted)]">{data.description}</p>
      ) : null}

      <div className="mb-6 flex flex-wrap gap-2">
        {data.status === "stopped" ? (
          <Button
            variant="outline"
            disabled={start.isPending}
            onClick={() => start.mutate({ swarmId: data.id })}
          >
            <Play className="h-3.5 w-3.5" /> {start.isPending ? "Starting…" : "Start"}
          </Button>
        ) : null}
        {data.status === "running" ? (
          <Button
            variant="outline"
            disabled={stop.isPending}
            onClick={() => stop.mutate({ swarmId: data.id })}
          >
            <Square className="h-3.5 w-3.5" /> {stop.isPending ? "Stopping…" : "Stop"}
          </Button>
        ) : null}
        {data.status !== "destroyed" ? (
          <Button
            variant="outline"
            disabled={destroy.isPending}
            onClick={() => {
              if (confirm("Destroy container? Threads + messages are kept.")) {
                destroy.mutate({ swarmId: data.id });
              }
            }}
          >
            <Trash2 className="h-3.5 w-3.5" /> {destroy.isPending ? "Destroying…" : "Destroy"}
          </Button>
        ) : null}
        <Button
          variant="destructive"
          disabled={deleteSwarm.isPending}
          onClick={() => {
            const typed = prompt(
              `Type the swarm slug "${data.slug}" to permanently delete it (container + all threads, messages, runs).`,
            );
            if (typed === data.slug) {
              deleteSwarm.mutate({ swarmId: data.id });
            } else if (typed !== null) {
              alert("slug did not match — deletion cancelled");
            }
          }}
        >
          <Trash2 className="h-3.5 w-3.5" /> {deleteSwarm.isPending ? "Deleting…" : "Delete swarm"}
        </Button>
      </div>

      <div className="grid grid-cols-[14rem_1fr] gap-4">
        <aside className="rounded-md border border-[var(--color-border)] p-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">Threads</h2>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => createThread.mutate({ swarmId: data.id })}
              disabled={createThread.isPending}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          <ul className="flex flex-col gap-1">
            {(threadsQ.data ?? []).map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setActiveThreadId(t.id)}
                  className={
                    "w-full rounded-md px-2 py-1 text-left text-sm " +
                    (activeThreadId === t.id ? "bg-white/10" : "hover:bg-white/5")
                  }
                >
                  <div className="truncate">{t.title ?? "Untitled"}</div>
                  <div className="text-[10px] text-[var(--color-muted)]">
                    {new Date(t.createdAt as any).toLocaleString()}
                  </div>
                </button>
              </li>
            ))}
            {(threadsQ.data ?? []).length === 0 ? (
              <li className="text-xs text-[var(--color-muted)]">No threads. Click + to start.</li>
            ) : null}
          </ul>
        </aside>

        <section className="flex flex-col gap-3">
          {activeThreadId && session?.session?.id && activeRunId ? (
            <AgentMessageStream
              runId={activeRunId}
              sessionId={session.session.id}
              onComplete={() => {
                utils.agenthive.listMessages.invalidate({ threadId: activeThreadId });
              }}
            />
          ) : null}

          <div className="rounded-md border border-[var(--color-border)] p-3">
            <div className="mb-2 text-xs uppercase tracking-wide text-[var(--color-muted)]">
              History
            </div>
            <div className="flex flex-col gap-2">
              {(messagesQ.data ?? []).map((m) => (
                <div
                  key={m.id}
                  className={
                    "rounded-md border border-[var(--color-border)] p-2 " +
                    (m.role === "user" ? "bg-[var(--color-accent)]/5" : "bg-white/[0.02]")
                  }
                >
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
                    {m.role}
                    {m.sender ? ` · ${m.sender}` : ""}
                    {m.receiver ? ` → ${m.receiver}` : ""}
                  </div>
                  <div className="whitespace-pre-wrap text-sm">
                    {m.content && (m.content as any).type === "text"
                      ? (m.content as any).text
                      : JSON.stringify(m.content)}
                  </div>
                </div>
              ))}
              {(messagesQ.data ?? []).length === 0 ? (
                <div className="text-xs text-[var(--color-muted)]">No messages yet.</div>
              ) : null}
            </div>
          </div>

          <form onSubmit={sendUserMessage} className="flex gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                isRunning && activeThreadId
                  ? "Send a message to the entry agent…"
                  : activeThreadId
                    ? "Swarm is not running — Start above to chat."
                    : "Create a thread to start chatting."
              }
              disabled={!isRunning || !activeThreadId || startRun.isPending}
            />
            <Button
              type="submit"
              disabled={!isRunning || !activeThreadId || !draft.trim() || startRun.isPending}
            >
              {startRun.isPending ? "Sending…" : "Send"}
            </Button>
          </form>
          {startRun.error ? (
            <div className="text-sm text-[var(--color-error)]">{startRun.error.message}</div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
