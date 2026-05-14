"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2 } from "lucide-react";

type LlmProvider =
  | "anthropic"
  | "gemini"
  | "groq"
  | "mistral"
  | "deepseek"
  | "openrouter"
  | "together_ai"
  | "xai"
  | "fireworks_ai"
  | "cohere";

type LlmDraft =
  | { backend: "openai"; model: string }
  | { backend: "provider"; provider: LlmProvider; model: string }
  | { backend: "local"; modelProjectId: string };

type AgentDraft = {
  name: string;
  role: string;
  instructions: string;
  llm: LlmDraft;
};

type FlowDraft = { from: string; to: string; via: "send_message" | "handoff" };

// Provider id -> display label + a sensible default model id.
const PROVIDERS: Record<LlmProvider, { label: string; defaultModel: string }> = {
  anthropic: { label: "Anthropic", defaultModel: "claude-sonnet-4-6" },
  gemini: { label: "Google Gemini", defaultModel: "gemini-2.0-flash" },
  groq: { label: "Groq", defaultModel: "llama-3.3-70b-versatile" },
  mistral: { label: "Mistral", defaultModel: "mistral-large-latest" },
  deepseek: { label: "DeepSeek", defaultModel: "deepseek-chat" },
  openrouter: { label: "OpenRouter", defaultModel: "openai/gpt-4o-mini" },
  together_ai: { label: "Together AI", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  xai: { label: "xAI Grok", defaultModel: "grok-2-latest" },
  fireworks_ai: { label: "Fireworks", defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct" },
  cohere: { label: "Cohere", defaultModel: "command-r-plus" },
};
const PROVIDER_IDS = Object.keys(PROVIDERS) as LlmProvider[];

const DEFAULT_AGENT: AgentDraft = {
  name: "ceo",
  role: "CEO",
  instructions:
    "You are the CEO. Decide which specialist to delegate to. Use send_message to ask a specialist a question, then synthesise the answer.",
  llm: { backend: "openai", model: "gpt-4o-mini" },
};

const DEFAULT_AGENT_2: AgentDraft = {
  name: "developer",
  role: "Developer",
  instructions: "You are a senior developer. Answer technical questions concisely.",
  llm: { backend: "openai", model: "gpt-4o-mini" },
};

export default function NewSwarmPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  // provider id -> API key, filled in dynamically as agents pick providers.
  const [providerKeys, setProviderKeys] = useState<Partial<Record<LlmProvider, string>>>({});
  const [agents, setAgents] = useState<AgentDraft[]>([DEFAULT_AGENT, DEFAULT_AGENT_2]);
  const [flows, setFlows] = useState<FlowDraft[]>([
    { from: "ceo", to: "developer", via: "send_message" },
  ]);
  const [entryAgent, setEntryAgent] = useState("ceo");
  const [defaultPattern, setDefaultPattern] = useState<"auto" | "handoff" | "orchestrator_worker">(
    "auto",
  );
  const [err, setErr] = useState<string | null>(null);

  const projectsQ = trpc.projects.list.useQuery();
  const localModels = useMemo(
    () => (projectsQ.data?.model ?? []).filter((m) => m.status === "running" && m.apiUrl),
    [projectsQ.data],
  );

  const usesOpenAI = agents.some((a) => a.llm.backend === "openai");
  const usedProviders = useMemo(() => {
    const set = new Set<LlmProvider>();
    for (const a of agents) {
      if (a.llm.backend === "provider") set.add(a.llm.provider);
    }
    return [...set];
  }, [agents]);

  const create = trpc.agenthive.create.useMutation({
    onSuccess: (swarm) => router.push(`/swarms/${swarm.id}` as any),
    onError: (e) => setErr(e.message),
  });

  function addAgent() {
    setAgents((a) => [
      ...a,
      {
        name: `agent${a.length + 1}`,
        role: "Specialist",
        instructions: "",
        llm: { backend: "openai", model: "gpt-4o-mini" },
      },
    ]);
  }

  function updateAgent(idx: number, patch: Partial<AgentDraft>) {
    setAgents((a) => a.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
  }

  // Renaming an agent must cascade into every reference: communication flows
  // and the entry-agent selection. Otherwise the spec fails validation with
  // "flow.to <old name> not in agents".
  function renameAgent(idx: number, rawName: string) {
    const newName = rawName.replace(/[^a-zA-Z0-9_]/g, "");
    setAgents((prev) => {
      const oldName = prev[idx]?.name;
      if (oldName === undefined) return prev;
      const next = prev.map((x, i) => (i === idx ? { ...x, name: newName } : x));
      if (oldName && oldName !== newName) {
        setFlows((fs) =>
          fs.map((f) => ({
            ...f,
            from: f.from === oldName ? newName : f.from,
            to: f.to === oldName ? newName : f.to,
          })),
        );
        setEntryAgent((e) => (e === oldName ? newName : e));
      }
      return next;
    });
  }

  function removeAgent(idx: number) {
    setAgents((a) => {
      const removed = a[idx]?.name;
      const next = a.filter((_, i) => i !== idx);
      if (removed) {
        // Drop flows touching the removed agent; reset entry if it pointed here.
        setFlows((fs) => fs.filter((f) => f.from !== removed && f.to !== removed));
        setEntryAgent((e) => (e === removed ? (next[0]?.name ?? "") : e));
      }
      return next;
    });
  }

  function setBackend(idx: number, backend: LlmDraft["backend"]) {
    if (backend === "openai") {
      updateAgent(idx, { llm: { backend: "openai", model: "gpt-4o-mini" } });
    } else if (backend === "local") {
      const first = localModels[0];
      updateAgent(idx, {
        llm: { backend: "local", modelProjectId: first ? first.id : "" },
      });
    } else {
      const provider: LlmProvider = "anthropic";
      updateAgent(idx, {
        llm: { backend: "provider", provider, model: PROVIDERS[provider].defaultModel },
      });
    }
  }

  function addFlow() {
    if (agents.length < 2) return;
    setFlows((f) => [...f, { from: agents[0]!.name, to: agents[1]!.name, via: "send_message" }]);
  }

  function updateFlow(idx: number, patch: Partial<FlowDraft>) {
    setFlows((f) => f.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
  }

  function removeFlow(idx: number) {
    setFlows((f) => f.filter((_, i) => i !== idx));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!agents.find((a) => a.name === entryAgent)) {
      setErr("entry agent must be one of the agents");
      return;
    }
    if (usesOpenAI && !openaiApiKey) {
      setErr("an agent uses the OpenAI backend — provide an OpenAI API key");
      return;
    }
    for (const p of usedProviders) {
      if (!providerKeys[p]) {
        setErr(`an agent uses ${PROVIDERS[p].label} — provide its API key`);
        return;
      }
    }
    const cleanedProviderKeys: Record<string, string> = {};
    for (const p of usedProviders) {
      const k = providerKeys[p];
      if (k) cleanedProviderKeys[p] = k;
    }
    create.mutate({
      name,
      description,
      openaiApiKey: openaiApiKey || undefined,
      providerKeys: Object.keys(cleanedProviderKeys).length ? cleanedProviderKeys : undefined,
      spec: {
        agents,
        communicationFlows: flows,
        orchestration: { entryAgent, defaultPattern },
      },
    });
  }

  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-2xl font-semibold">New Swarm</h1>
      <p className="mb-6 text-sm text-[var(--color-muted)]">
        Define agents and how they message each other. Patterns: <code>send_message</code> (delegate
        & collect) or <code>handoff</code> (transfer control). Agents can run on OpenAI, any major
        provider via LiteLLM, or your Orqestra-hosted local models.
      </p>

      <form className="flex flex-col gap-5" onSubmit={onSubmit}>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm">Description (optional)</span>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
          />
        </label>

        <section className="rounded-md border border-[var(--color-border)] p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Agents</h2>
            <Button type="button" size="sm" variant="outline" onClick={addAgent}>
              <Plus className="h-3.5 w-3.5" /> Add agent
            </Button>
          </div>
          <div className="flex flex-col gap-4">
            {agents.map((a, i) => (
              <div key={i} className="rounded-md border border-[var(--color-border)] p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <Input
                    value={a.name}
                    onChange={(e) => renameAgent(i, e.target.value)}
                    placeholder="agent_identifier"
                    className="max-w-[14rem] font-mono"
                  />
                  <Input
                    value={a.role}
                    onChange={(e) => updateAgent(i, { role: e.target.value })}
                    placeholder="Role label"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => removeAgent(i)}
                    disabled={agents.length <= 1}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <Textarea
                  value={a.instructions}
                  onChange={(e) => updateAgent(i, { instructions: e.target.value })}
                  placeholder="Full system prompt for this agent"
                  className="mb-2 min-h-[5rem]"
                />
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <select
                    value={a.llm.backend}
                    onChange={(e) => setBackend(i, e.target.value as LlmDraft["backend"])}
                    className="h-9 rounded-md border border-[var(--color-border)] bg-transparent px-2 text-sm"
                  >
                    <option value="openai">OpenAI cloud</option>
                    <option value="provider">Provider (LiteLLM)</option>
                    <option value="local">Local (Orqestra-hosted)</option>
                  </select>

                  {a.llm.backend === "openai" ? (
                    <Input
                      value={a.llm.model}
                      onChange={(e) =>
                        updateAgent(i, { llm: { backend: "openai", model: e.target.value } })
                      }
                      placeholder="gpt-4o-mini"
                      className="max-w-[14rem]"
                    />
                  ) : a.llm.backend === "provider" ? (
                    <>
                      <select
                        value={a.llm.provider}
                        onChange={(e) => {
                          const provider = e.target.value as LlmProvider;
                          updateAgent(i, {
                            llm: {
                              backend: "provider",
                              provider,
                              model: PROVIDERS[provider].defaultModel,
                            },
                          });
                        }}
                        className="h-9 rounded-md border border-[var(--color-border)] bg-transparent px-2 text-sm"
                      >
                        {PROVIDER_IDS.map((p) => (
                          <option key={p} value={p}>
                            {PROVIDERS[p].label}
                          </option>
                        ))}
                      </select>
                      <Input
                        value={a.llm.model}
                        onChange={(e) => {
                          const llm = a.llm as Extract<LlmDraft, { backend: "provider" }>;
                          updateAgent(i, {
                            llm: { backend: "provider", provider: llm.provider, model: e.target.value },
                          });
                        }}
                        placeholder="model id"
                        className="max-w-[18rem] font-mono"
                      />
                    </>
                  ) : (
                    <select
                      value={a.llm.modelProjectId}
                      onChange={(e) =>
                        updateAgent(i, {
                          llm: { backend: "local", modelProjectId: e.target.value },
                        })
                      }
                      className="h-9 rounded-md border border-[var(--color-border)] bg-transparent px-2 text-sm"
                    >
                      <option value="">-- pick a running model project --</option>
                      {localModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.slug})
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* API keys — one field per backend actually used by the agents above. */}
        {usesOpenAI || usedProviders.length > 0 ? (
          <section className="rounded-md border border-[var(--color-border)] p-4">
            <h2 className="mb-1 text-sm font-semibold">API keys</h2>
            <p className="mb-3 text-xs text-[var(--color-muted)]">
              One key per provider used above. Injected into the swarm container's env, not
              persisted in the database.
            </p>
            <div className="flex flex-col gap-3">
              {usesOpenAI ? (
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm">OpenAI API key</span>
                  <Input
                    type="password"
                    value={openaiApiKey}
                    onChange={(e) => setOpenaiApiKey(e.target.value)}
                    placeholder="sk-…"
                    autoComplete="off"
                  />
                </label>
              ) : null}
              {usedProviders.map((p) => (
                <label key={p} className="flex flex-col gap-1.5">
                  <span className="text-sm">{PROVIDERS[p].label} API key</span>
                  <Input
                    type="password"
                    value={providerKeys[p] ?? ""}
                    onChange={(e) =>
                      setProviderKeys((prev) => ({ ...prev, [p]: e.target.value }))
                    }
                    placeholder="API key"
                    autoComplete="off"
                  />
                </label>
              ))}
            </div>
          </section>
        ) : null}

        <section className="rounded-md border border-[var(--color-border)] p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Communication flows</h2>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={addFlow}
              disabled={agents.length < 2}
            >
              <Plus className="h-3.5 w-3.5" /> Add flow
            </Button>
          </div>
          {flows.length === 0 ? (
            <p className="text-sm text-[var(--color-muted)]">
              Add at least one flow so agents can talk. Otherwise the entry agent runs solo.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {flows.map((f, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <select
                    value={f.from}
                    onChange={(e) => updateFlow(i, { from: e.target.value })}
                    className="h-9 rounded-md border border-[var(--color-border)] bg-transparent px-2 text-sm"
                  >
                    {agents.map((a) => (
                      <option key={a.name} value={a.name}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-[var(--color-muted)]">→</span>
                  <select
                    value={f.to}
                    onChange={(e) => updateFlow(i, { to: e.target.value })}
                    className="h-9 rounded-md border border-[var(--color-border)] bg-transparent px-2 text-sm"
                  >
                    {agents.map((a) => (
                      <option key={a.name} value={a.name}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={f.via}
                    onChange={(e) =>
                      updateFlow(i, { via: e.target.value as "send_message" | "handoff" })
                    }
                    className="h-9 rounded-md border border-[var(--color-border)] bg-transparent px-2 text-sm"
                  >
                    <option value="send_message">send_message</option>
                    <option value="handoff">handoff</option>
                  </select>
                  <Button type="button" size="sm" variant="ghost" onClick={() => removeFlow(i)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-md border border-[var(--color-border)] p-4">
          <h2 className="mb-3 text-sm font-semibold">Orchestration</h2>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-2">
              <span>Entry agent</span>
              <select
                value={entryAgent}
                onChange={(e) => setEntryAgent(e.target.value)}
                className="h-9 rounded-md border border-[var(--color-border)] bg-transparent px-2 text-sm"
              >
                {agents.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span>Default pattern</span>
              <select
                value={defaultPattern}
                onChange={(e) =>
                  setDefaultPattern(e.target.value as "auto" | "handoff" | "orchestrator_worker")
                }
                className="h-9 rounded-md border border-[var(--color-border)] bg-transparent px-2 text-sm"
              >
                <option value="auto">auto (entry agent decides)</option>
                <option value="handoff">handoff</option>
                <option value="orchestrator_worker">orchestrator_worker</option>
              </select>
            </label>
          </div>
        </section>

        {err ? <div className="text-sm text-[var(--color-error)]">{err}</div> : null}
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? "Creating swarm…" : "Create swarm"}
        </Button>
      </form>
    </div>
  );
}
