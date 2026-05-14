"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { SwarmDesigner } from "@/components/swarm-designer";

export default function NewSwarmPage() {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);

  const create = trpc.agenthive.create.useMutation({
    onSuccess: (swarm) => router.push(`/swarms/${swarm.id}` as any),
    onError: (e) => setErr(e.message),
  });

  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-2xl font-semibold">New Swarm</h1>
      <p className="mb-6 text-sm text-[var(--color-muted)]">
        Define agents and how they message each other. Patterns: <code>send_message</code> (delegate
        & collect) or <code>handoff</code> (transfer control). Agents can run on OpenAI, any major
        provider via LiteLLM, or your Orqestra-hosted local models.
      </p>
      <SwarmDesigner
        submitLabel="Create swarm"
        submittingLabel="Creating swarm…"
        pending={create.isPending}
        serverError={err}
        onSubmit={(payload) => {
          setErr(null);
          create.mutate(payload);
        }}
      />
    </div>
  );
}
