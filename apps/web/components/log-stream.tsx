"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface Props {
  projectId: string;
  sessionId: string;
  className?: string;
  title?: string;
}

type LogEvent =
  | { type: "log"; line: string; ts: number }
  | { type: "done"; ok: boolean }
  | { type: "error"; message: string }
  | { type: "subscribed" | "unsubscribed" };

export function LogStream({ projectId, sessionId, className, title = "Container logs" }: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [state, setState] = useState<"connecting" | "open" | "done-ok" | "done-fail" | "closed">("connecting");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_WS_URL?.replace(/\/$/, "") + "/ws";
    if (!url) return;
    const ws = new WebSocket(url);

    ws.addEventListener("open", () => {
      setState("open");
      ws.send(JSON.stringify({ type: "subscribe", projectId, sessionId }));
    });

    ws.addEventListener("message", (ev) => {
      let msg: LogEvent;
      try {
        msg = JSON.parse(ev.data) as LogEvent;
      } catch {
        return;
      }
      if (msg.type === "log") setLines((prev) => [...prev, msg.line]);
      else if (msg.type === "done") setState(msg.ok ? "done-ok" : "done-fail");
      else if (msg.type === "error") setLines((prev) => [...prev, `[error] ${msg.message}`]);
    });

    ws.addEventListener("close", () => setState("closed"));

    return () => {
      ws.close();
    };
  }, [projectId, sessionId]);

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines]);

  return (
    <div className={cn("flex flex-col rounded-md border border-[var(--color-border)] bg-black", className)}>
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2 text-xs">
        <span className="text-[var(--color-muted)]">{title}</span>
        <span
          className={cn(
            "font-medium",
            state === "open" && "text-[var(--color-info)]",
            state === "done-ok" && "text-[var(--color-success)]",
            state === "done-fail" && "text-[var(--color-error)]",
            state === "closed" && "text-[var(--color-muted)]",
          )}
        >
          {state === "open" && "Streaming…"}
          {state === "connecting" && "Connecting…"}
          {state === "done-ok" && "Build complete"}
          {state === "done-fail" && "Build failed"}
          {state === "closed" && "Disconnected"}
        </span>
      </div>
      <div ref={ref} className="max-h-96 overflow-y-auto p-3 font-mono text-xs leading-5 text-zinc-200">
        {lines.length === 0 ? (
          <div className="text-[var(--color-muted)]">Waiting for logs…</div>
        ) : (
          lines.map((line, i) => <div key={i}>{line}</div>)
        )}
      </div>
    </div>
  );
}
