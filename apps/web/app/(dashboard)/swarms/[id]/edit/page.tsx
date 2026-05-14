"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { trpc } from "@/lib/trpc";
import {
  SwarmDesigner,
  type SwarmDesignerValue,
  type AgentDraft,
  type FlowDraft,
} from "@/components/swarm-designer";
import { Button } from "@/components/ui/button";
import { ChevronLeft } from "lucide-react";

export default function EditSwarmPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const utils = trpc.useUtils();
  const [err, setErr] = useState<string | null>(null);

  const swarmQ = trpc.projects.getById.useQuery({ id, kind: "swarm" });

  const update = trpc.agenthive.updateSpec.useMutation({
    onSuccess: () => {
      utils.projects.getById.invalidate({ id, kind: "swarm" });
      router.push(`/swarms/${id}` as any);
    },
    onError: (e) => setErr(e.message),
  });

  if (swarmQ.isLoading || !swarmQ.data) {
    return <div className="text-sm text-[var(--color-muted)]">Loading…</div>;
  }
  if (swarmQ.data.kind !== "swarm") return null;
  const swarm = swarmQ.data;

  // Map the persisted spec into the designer's draft shape. The DB spec keeps
  // llm without resolved fields (apiUrl/modelName) — exactly the draft shape.
  const initial: SwarmDesignerValue = {
    name: swarm.name,
    description: swarm.description ?? "",
    agents: swarm.spec.agents as AgentDraft[],
    flows: swarm.spec.communicationFlows as FlowDraft[],
    entryAgent: swarm.spec.orchestration.entryAgent,
    defaultPattern: swarm.spec.orchestration.defaultPattern,
  };

  return (
    <div className="max-w-3xl">
      <Button asChild variant="ghost" size="sm" className="mb-3">
        <Link href={`/swarms/${id}` as any}>
          <ChevronLeft className="h-3.5 w-3.5" /> Back to swarm
        </Link>
      </Button>
      <h1 className="mb-1 text-2xl font-semibold">Edit Swarm</h1>
      <p className="mb-6 text-sm text-[var(--color-muted)]">
        Saving recreates the swarm's container with the new spec. The swarm, its threads, and
        message history are preserved. Re-enter API keys for any backends in use.
      </p>
      <SwarmDesigner
        initial={initial}
        submitLabel="Save changes"
        submittingLabel="Rebuilding swarm…"
        pending={update.isPending}
        serverError={err}
        onSubmit={(payload) => {
          setErr(null);
          update.mutate({ swarmId: id, ...payload });
        }}
      />
    </div>
  );
}
