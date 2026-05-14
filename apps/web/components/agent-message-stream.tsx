"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { MessageMarkdown } from "./message-markdown";

interface Props {
  runId: string;
  sessionId: string;
  className?: string;
  onComplete?: (ok: boolean) => void;
}

export type AgentEvent =
  | { type: "run_start"; runId: string; entryAgent: string }
  | { type: "run_end"; runId: string }
  | { type: "run_final"; text: string; agent?: string }
  | { type: "agent_updated"; agent: string }
  | { type: "message"; agent: string; role: string; text: string }
  | { type: "tool_call"; agent: string; name: string; args: Record<string, unknown> }
  | { type: "tool_output"; agent: string; name: string; result: unknown }
  | { type: "handoff_call"; agent: string; target: string; args: Record<string, unknown> }
  | { type: "handoff"; from: string; to?: string }
  | { type: "reasoning"; agent: string }
  | { type: "unknown_event"; kind: string }
  | { type: "error"; message: string }
  | { type: "raw"; text: string };

type WireMsg =
  | { type: "log"; line: string; ts: number }
  | { type: "done"; ok: boolean }
  | { type: "error"; message: string }
  | { type: "subscribed" | "unsubscribed" };

function parseEvent(line: string): AgentEvent | null {
  try {
    const obj = JSON.parse(line);
    if (obj && typeof obj === "object" && typeof obj.type === "string") {
      return obj as AgentEvent;
    }
  } catch {
    /* not JSON — surface as raw text */
  }
  return { type: "raw", text: line };
}

// Stable per-agent colour so badges are visually distinct.
const PALETTE = [
  "#6366f1", // indigo
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
  "#8b5cf6", // violet
];
export function agentColor(name: string | undefined): string {
  if (!name) return "#6b7280";
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export function AgentBadge({ name }: { name: string | undefined }) {
  const color = agentColor(name);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide"
      style={{ borderColor: color, color, backgroundColor: `${color}1f` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {name ?? "—"}
    </span>
  );
}

type Tab = "chat" | "trace";

export function AgentMessageStream({ runId, sessionId, className, onComplete }: Props) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [state, setState] = useState<"connecting" | "open" | "done-ok" | "done-fail" | "closed">(
    "connecting",
  );
  const [tab, setTab] = useState<Tab>("chat");
  const chatRef = useRef<HTMLDivElement>(null);
  const traceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const baseUrl = process.env.NEXT_PUBLIC_WS_URL?.replace(/\/$/, "");
    if (!baseUrl) return;
    const ws = new WebSocket(baseUrl + "/ws");

    ws.addEventListener("open", () => {
      setState("open");
      ws.send(JSON.stringify({ type: "subscribe", projectId: runId, sessionId }));
    });

    ws.addEventListener("message", (ev) => {
      let msg: WireMsg;
      try {
        msg = JSON.parse(ev.data) as WireMsg;
      } catch {
        return;
      }
      if (msg.type === "log") {
        const parsed = parseEvent(msg.line);
        if (parsed) setEvents((prev) => [...prev, parsed]);
      } else if (msg.type === "done") {
        setState(msg.ok ? "done-ok" : "done-fail");
        onComplete?.(msg.ok);
      } else if (msg.type === "error") {
        setEvents((prev) => [...prev, { type: "error", message: msg.message }]);
      }
    });

    ws.addEventListener("close", () => setState("closed"));

    return () => {
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, sessionId]);

  const chatEvents = useMemo(
    () => events.filter((e) => e.type === "message" || e.type === "run_final"),
    [events],
  );
  const traceCount = events.length;

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
    traceRef.current?.scrollTo({ top: traceRef.current.scrollHeight });
  }, [events]);

  return (
    <div className={cn("flex flex-col rounded-md border border-[var(--color-border)]", className)}>
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2 text-xs">
        <div className="flex items-center gap-1">
          <TabButton active={tab === "chat"} onClick={() => setTab("chat")}>
            Chat <span className="opacity-70">{chatEvents.length}</span>
          </TabButton>
          <TabButton active={tab === "trace"} onClick={() => setTab("trace")}>
            Trace <span className="opacity-70">{traceCount}</span>
          </TabButton>
        </div>
        <span
          className={cn(
            "font-medium",
            state === "open" && "text-[var(--color-info)]",
            state === "done-ok" && "text-[var(--color-success)]",
            state === "done-fail" && "text-[var(--color-error)]",
            state === "closed" && "text-[var(--color-muted)]",
          )}
        >
          {state === "open" && "Running…"}
          {state === "connecting" && "Connecting…"}
          {state === "done-ok" && "Run complete"}
          {state === "done-fail" && "Run failed"}
          {state === "closed" && "Disconnected"}
        </span>
      </div>

      {tab === "chat" ? (
        <div ref={chatRef} className="max-h-[60vh] overflow-y-auto p-3 text-sm">
          {chatEvents.length === 0 ? (
            <div className="text-[var(--color-muted)]">
              {state === "done-ok"
                ? "No agent messages produced. Switch to Trace for tool-call detail."
                : "Waiting for agents…"}
            </div>
          ) : (
            chatEvents.map((e, i) => <ChatBubble key={i} ev={e} />)
          )}
        </div>
      ) : (
        <div ref={traceRef} className="max-h-[60vh] overflow-y-auto p-3 text-sm">
          {events.length === 0 ? (
            <div className="text-[var(--color-muted)]">Waiting for agents…</div>
          ) : (
            events.map((e, i) => <TraceRow key={i} ev={e} />)
          )}
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md px-2 py-1 text-xs",
        active
          ? "bg-[var(--color-accent)] text-white"
          : "text-[var(--color-muted)] hover:bg-white/5",
      )}
    >
      {children}
    </button>
  );
}

function ChatBubble({ ev }: { ev: AgentEvent }) {
  if (ev.type === "message") {
    const color = agentColor(ev.agent);
    return (
      <div
        className="mb-3 rounded-md border bg-white/[0.02] p-3"
        style={{ borderColor: `${color}55` }}
      >
        <div className="mb-2 flex items-center gap-2">
          <AgentBadge name={ev.agent} />
          <span className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
            {ev.role}
          </span>
        </div>
        <MessageMarkdown>{ev.text}</MessageMarkdown>
      </div>
    );
  }
  if (ev.type === "run_final") {
    return (
      <div className="mb-3 rounded-md border border-[var(--color-success)]/40 bg-[var(--color-success)]/5 p-3">
        <div className="mb-2 flex items-center gap-2">
          <AgentBadge name={ev.agent} />
          <span className="text-[10px] uppercase tracking-wide text-[var(--color-success)]">
            final
          </span>
        </div>
        <MessageMarkdown>{ev.text}</MessageMarkdown>
      </div>
    );
  }
  return null;
}

function TraceRow({ ev }: { ev: AgentEvent }) {
  switch (ev.type) {
    case "raw":
      return <div className="py-1 font-mono text-xs">{ev.text}</div>;
    case "error":
      return (
        <div className="py-1 font-mono text-xs text-[var(--color-error)]">{ev.message}</div>
      );
    case "run_start":
      return (
        <div className="border-b border-[var(--color-border)] py-2 text-xs uppercase tracking-wide text-[var(--color-muted)]">
          Run started · entry <AgentBadge name={ev.entryAgent} />
        </div>
      );
    case "run_end":
      return (
        <div className="mt-2 border-t border-[var(--color-border)] pt-2 text-xs uppercase tracking-wide text-[var(--color-muted)]">
          Run ended
        </div>
      );
    case "agent_updated":
      return (
        <div className="my-2 flex items-center gap-2 text-xs">
          <span className="text-[var(--color-muted)]">Active agent →</span>
          <AgentBadge name={ev.agent} />
        </div>
      );
    case "handoff":
      return (
        <div className="my-2 flex items-center gap-2 rounded-md border border-[var(--color-info)]/40 bg-[var(--color-info)]/5 px-3 py-2 text-xs">
          <span className="text-[var(--color-muted)]">Handoff</span>
          <AgentBadge name={ev.from} /> <span>→</span> <AgentBadge name={ev.to} />
        </div>
      );
    case "handoff_call":
      return (
        <div className="my-1 flex items-center gap-2 text-xs">
          <AgentBadge name={ev.agent} />
          <span className="text-[var(--color-muted)]">requested handoff →</span>
          <AgentBadge name={ev.target} />
        </div>
      );
    case "tool_call":
      return (
        <div className="my-1 rounded-md border border-[var(--color-border)] bg-white/[0.02] p-2 text-xs">
          <div className="mb-1 flex items-center gap-2">
            <AgentBadge name={ev.agent} />
            <span className="text-[var(--color-muted)]">calls</span>
            <span className="font-mono text-[var(--color-fg)]">{ev.name}</span>
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[10px] text-[var(--color-muted)]">
            {JSON.stringify(ev.args, null, 2)}
          </pre>
        </div>
      );
    case "tool_output":
      return (
        <div className="my-1 rounded-md border border-[var(--color-border)] bg-black/30 p-2 text-xs">
          <div className="mb-1 flex items-center gap-2">
            <span className="font-mono">{ev.name}</span>
            <span className="text-[var(--color-muted)]">→</span>
            <AgentBadge name={ev.agent} />
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[10px]">
            {typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result, null, 2)}
          </pre>
        </div>
      );
    case "message":
      return (
        <div className="mb-3 rounded-md border border-[var(--color-border)] bg-white/[0.02] p-3">
          <div className="mb-2 flex items-center gap-2">
            <AgentBadge name={ev.agent} />
            <span className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
              {ev.role}
            </span>
          </div>
          <MessageMarkdown>{ev.text}</MessageMarkdown>
        </div>
      );
    case "run_final":
      return (
        <div className="mb-3 rounded-md border border-[var(--color-success)]/40 bg-[var(--color-success)]/5 p-3">
          <div className="mb-2 flex items-center gap-2">
            <AgentBadge name={ev.agent} />
            <span className="text-[10px] uppercase tracking-wide text-[var(--color-success)]">
              final
            </span>
          </div>
          <MessageMarkdown>{ev.text}</MessageMarkdown>
        </div>
      );
    case "reasoning":
      return (
        <div className="my-1 flex items-center gap-2 text-[10px] italic text-[var(--color-muted)]">
          <AgentBadge name={ev.agent} /> reasoning…
        </div>
      );
    case "unknown_event":
      return (
        <div className="my-1 font-mono text-[10px] text-[var(--color-muted)]">
          unknown event: {ev.kind}
        </div>
      );
    default:
      return (
        <div className="my-1 font-mono text-[10px] text-[var(--color-muted)]">
          {JSON.stringify(ev)}
        </div>
      );
  }
}
