"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

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

export function AgentMessageStream({ runId, sessionId, className, onComplete }: Props) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [state, setState] = useState<"connecting" | "open" | "done-ok" | "done-fail" | "closed">(
    "connecting",
  );
  const ref = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [events]);

  return (
    <div className={cn("flex flex-col rounded-md border border-[var(--color-border)]", className)}>
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2 text-xs">
        <span className="text-[var(--color-muted)]">Agent stream</span>
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
      <div ref={ref} className="max-h-[60vh] overflow-y-auto p-3 text-sm">
        {events.length === 0 ? (
          <div className="text-[var(--color-muted)]">Waiting for agents…</div>
        ) : (
          events.map((e, i) => <EventRow key={i} ev={e} />)
        )}
      </div>
    </div>
  );
}

function EventRow({ ev }: { ev: AgentEvent }) {
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
          Run started · entry <span className="font-mono">{ev.entryAgent}</span>
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
        <div className="my-2 text-xs uppercase tracking-wide text-[var(--color-info)]">
          Active agent → <span className="font-mono">{ev.agent}</span>
        </div>
      );
    case "handoff":
      return (
        <div className="my-2 rounded-md border border-[var(--color-info)]/40 bg-[var(--color-info)]/5 px-3 py-2 text-xs">
          Handoff <span className="font-mono">{ev.from}</span> →{" "}
          <span className="font-mono">{ev.to ?? "?"}</span>
        </div>
      );
    case "handoff_call":
      return (
        <div className="my-1 text-xs text-[var(--color-muted)]">
          <span className="font-mono">{ev.agent}</span> requested handoff →{" "}
          <span className="font-mono">{ev.target}</span>
        </div>
      );
    case "tool_call":
      return (
        <div className="my-1 rounded-md border border-[var(--color-border)] bg-white/[0.02] p-2 text-xs">
          <div className="mb-1 text-[var(--color-muted)]">
            <span className="font-mono">{ev.agent}</span> calls{" "}
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
          <div className="mb-1 text-[var(--color-muted)]">
            <span className="font-mono">{ev.name}</span> returned to{" "}
            <span className="font-mono">{ev.agent}</span>
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[10px]">
            {typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result, null, 2)}
          </pre>
        </div>
      );
    case "message":
      return (
        <div className="mb-3 rounded-md border border-[var(--color-border)] bg-white/[0.02] p-3">
          <div className="mb-1 text-xs text-[var(--color-muted)]">
            <span className="font-mono">{ev.agent}</span> · {ev.role}
          </div>
          <div className="whitespace-pre-wrap text-sm">{ev.text}</div>
        </div>
      );
    case "run_final":
      return (
        <div className="mb-3 rounded-md border border-[var(--color-success)]/40 bg-[var(--color-success)]/5 p-3">
          <div className="mb-1 text-xs text-[var(--color-muted)]">
            final · <span className="font-mono">{ev.agent ?? ""}</span>
          </div>
          <div className="whitespace-pre-wrap text-sm">{ev.text}</div>
        </div>
      );
    case "reasoning":
      return (
        <div className="my-1 text-[10px] italic text-[var(--color-muted)]">
          <span className="font-mono">{ev.agent}</span> reasoning…
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
