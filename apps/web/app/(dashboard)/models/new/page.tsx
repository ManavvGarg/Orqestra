"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Cpu, MemoryStick, Search, Star, Zap } from "lucide-react";

type Runtime = "ollama" | "docker-model-runner" | "llama-cpp";
type GpuMode = "off" | "auto" | "specific";

function useDebounced<T>(value: T, delayMs = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return v;
}

function fmtBytes(n: number) {
  if (!n) return "—";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtCount(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${n}`;
}

export default function NewModelHostingPage() {
  const router = useRouter();
  const utils = trpc.useUtils();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [provider, setProvider] = useState<"dmr" | "ollama">("dmr");
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search, 300);

  const [pickedRef, setPickedRef] = useState<string | null>(null);
  const [pickedTag, setPickedTag] = useState<string | null>(null);
  const [ramLimitGB, setRamLimitGB] = useState<number | null>(null);
  const [cpuLimit, setCpuLimit] = useState<number | null>(null);
  const [gpuMode, setGpuMode] = useState<GpuMode>("auto");
  const [gpuIndex, setGpuIndex] = useState<number | null>(null);
  const [vramAllocGB, setVramAllocGB] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const capQ = trpc.models.capabilities.useQuery();
  const backendsQ = trpc.models.catalogBackends.useQuery();
  const searchQ = trpc.models.catalogSearch.useQuery(
    { q: debounced, provider },
    { placeholderData: (prev) => prev },
  );
  const tagsQ = trpc.models.catalogTags.useQuery(
    { ref: pickedRef ?? "", provider },
    { enabled: !!pickedRef },
  );

  const create = trpc.models.createFromRef.useMutation({
    onSuccess: (project) => {
      utils.projects.list.invalidate();
      router.push(`/models/${project.id}` as any);
    },
    onError: (e) => setErr(e.message),
  });

  const cap = capQ.data;
  const backends = backendsQ.data;
  const runtime: Runtime = provider === "ollama" ? "ollama" : "docker-model-runner";

  const fullRef = useMemo(() => {
    if (!pickedRef) return null;
    if (provider === "ollama") {
      return pickedTag ? `${pickedRef}:${pickedTag}` : `${pickedRef}:latest`;
    }
    return pickedTag ? `${pickedRef}:${pickedTag}` : pickedRef;
  }, [pickedRef, pickedTag, provider]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!fullRef) {
      setErr("pick a model + tag");
      return;
    }
    let gpu:
      | { mode: "off" }
      | { mode: "auto" }
      | { mode: "specific"; gpuIndex: number; vramLimitMB?: number };
    if (gpuMode === "off") gpu = { mode: "off" };
    else if (gpuMode === "auto") gpu = { mode: "auto" };
    else {
      if (gpuIndex === null) {
        setErr("pick a GPU");
        return;
      }
      gpu = {
        mode: "specific",
        gpuIndex,
        vramLimitMB: vramAllocGB ? Math.round(vramAllocGB * 1024) : undefined,
      };
    }
    create.mutate({
      name,
      description,
      runtime,
      ref: fullRef,
      ramLimitGB: ramLimitGB ?? undefined,
      cpuLimit: cpuLimit ?? undefined,
      gpu,
    });
  }

  if (capQ.isLoading || !cap) {
    return <div className="text-sm text-[var(--color-muted)]">Loading host capabilities…</div>;
  }
  const freeRamGB = cap.freeRamGB - cap.committedRamGB;
  const freeVramGB = cap.gpus.reduce(
    (s, g) => s + Math.max(0, g.vramFreeGB - g.committedVramGB),
    0,
  );

  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-2xl font-semibold">Host a model</h1>
      <p className="mb-6 text-sm text-[var(--color-muted)]">
        Search the live catalog (Docker Model Runner or Ollama). The container exposes an
        OpenAI-compatible API.
      </p>

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat
          icon={<MemoryStick className="h-4 w-4" />}
          label="Free RAM"
          value={`${freeRamGB.toFixed(1)} / ${cap.totalRamGB.toFixed(1)} GB`}
        />
        <Stat
          icon={<Cpu className="h-4 w-4" />}
          label="CPU cores"
          value={`${cap.cpuCores}`}
          sub={`${cap.committedCpu.toFixed(1)} committed`}
        />
        <Stat
          icon={<Zap className="h-4 w-4" />}
          label="GPUs"
          value={cap.hasGPU ? `${cap.gpus.length} × ${cap.gpus[0]?.name ?? ""}` : "none"}
          sub={cap.hasGPU ? `${freeVramGB.toFixed(1)} GB VRAM free` : "CPU-only"}
        />
      </div>

      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm">Project name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm">Description (optional)</span>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>

        <fieldset className="flex flex-col gap-2">
          <span className="text-sm">Provider</span>
          <div className="flex flex-wrap gap-2">
            {(
              [
                {
                  v: "dmr",
                  label: "Docker Model Runner",
                  enabled: backends?.dmrInstalled ?? false,
                  hint: backends?.dmrInstalled ? "" : "not installed",
                },
                {
                  v: "ollama",
                  label: "Ollama",
                  enabled: true,
                  hint: backends?.ollamaPresent ? "" : "image pulled on first run",
                },
              ] as const
            ).map((p) => (
              <button
                key={p.v}
                type="button"
                disabled={!p.enabled}
                onClick={() => {
                  setProvider(p.v);
                  setPickedRef(null);
                  setPickedTag(null);
                }}
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  provider === p.v
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10"
                    : "border-[var(--color-border)] hover:bg-white/5"
                } ${!p.enabled ? "opacity-40" : ""}`}
              >
                {p.label}
                {p.hint ? (
                  <span className="ml-2 text-xs text-[var(--color-muted)]">({p.hint})</span>
                ) : null}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <span className="text-sm">Search models</span>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-[var(--color-muted)]" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                provider === "dmr" ? "qwen3, llama, gemma…" : "llama3.2, qwen2.5, gemma2…"
              }
              className="pl-8"
            />
          </div>
          <div className="grid max-h-80 grid-cols-1 gap-1 overflow-y-auto rounded-md border border-[var(--color-border)] p-1">
            {searchQ.isLoading && !searchQ.data ? (
              <div className="p-3 text-xs text-[var(--color-muted)]">Searching…</div>
            ) : searchQ.error ? (
              <div className="p-3 text-xs text-[var(--color-error)]">{searchQ.error.message}</div>
            ) : (searchQ.data?.models ?? []).length === 0 ? (
              <div className="p-3 text-xs text-[var(--color-muted)]">No matches.</div>
            ) : (
              (searchQ.data?.models ?? []).map((m) => {
                const sel = pickedRef === m.name;
                return (
                  <button
                    type="button"
                    key={`${m.provider}:${m.name}`}
                    onClick={() => {
                      setPickedRef(m.name);
                      setPickedTag(null);
                    }}
                    className={`flex flex-col gap-0.5 rounded px-2.5 py-2 text-left text-sm hover:bg-white/5 ${
                      sel ? "bg-[var(--color-accent)]/10 ring-1 ring-[var(--color-accent)]" : ""
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-mono text-sm">{m.name}</span>
                      <span className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
                        {m.backend ? (
                          <span className="rounded bg-white/5 px-1.5">{m.backend}</span>
                        ) : null}
                        {m.pullCount ? <span>↓ {fmtCount(m.pullCount)}</span> : null}
                        {m.starCount ? (
                          <span className="flex items-center gap-0.5">
                            <Star className="h-3 w-3" />
                            {fmtCount(m.starCount)}
                          </span>
                        ) : null}
                      </span>
                    </div>
                    {m.description ? (
                      <div className="line-clamp-1 text-xs text-[var(--color-muted)]">
                        {m.description}
                      </div>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
        </fieldset>

        {pickedRef ? (
          <fieldset className="flex flex-col gap-2">
            <span className="text-sm">
              Tag for <span className="font-mono">{pickedRef}</span>
            </span>
            {tagsQ.isLoading ? (
              <div className="text-xs text-[var(--color-muted)]">Loading tags…</div>
            ) : tagsQ.error ? (
              <div className="text-xs text-[var(--color-error)]">{tagsQ.error.message}</div>
            ) : (tagsQ.data?.tags ?? []).length === 0 ? (
              <div className="text-xs text-[var(--color-muted)]">
                No tags found. Try the default tag (leave empty).
              </div>
            ) : (
              <div className="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto rounded-md border border-[var(--color-border)] p-1 sm:grid-cols-2">
                {(tagsQ.data?.tags ?? []).map((t) => {
                  const sel = pickedTag === t.name;
                  return (
                    <button
                      type="button"
                      key={t.name}
                      onClick={() => setPickedTag(t.name)}
                      className={`flex items-center justify-between rounded px-2.5 py-2 text-left text-sm hover:bg-white/5 ${
                        sel
                          ? "bg-[var(--color-accent)]/10 ring-1 ring-[var(--color-accent)]"
                          : ""
                      }`}
                    >
                      <span className="font-mono text-xs">{t.name}</span>
                      <span className="text-xs text-[var(--color-muted)]">
                        {fmtBytes(t.sizeBytes)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {fullRef ? (
              <div className="mt-1 text-xs">
                Full ref:{" "}
                <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono">{fullRef}</code>
              </div>
            ) : null}
          </fieldset>
        ) : null}

        {pickedRef ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm">RAM limit (GB) — optional</span>
              <Input
                type="number"
                min={1}
                step={0.5}
                value={ramLimitGB ?? ""}
                placeholder={`auto (≈${Math.min(8, Math.max(2, freeRamGB - 1)).toFixed(1)} GB)`}
                onChange={(e) =>
                  setRamLimitGB(e.target.value ? parseFloat(e.target.value) : null)
                }
              />
              <span className="text-xs text-[var(--color-muted)]">
                Free: {freeRamGB.toFixed(1)} / {cap.totalRamGB.toFixed(1)} GB
              </span>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm">CPU cores — optional</span>
              <Input
                type="number"
                min={1}
                max={cap.cpuCores}
                step={0.5}
                value={cpuLimit ?? ""}
                placeholder={`auto (${Math.max(1, Math.min(cap.cpuCores - cap.committedCpu, cap.cpuCores - 1)).toFixed(0)} cores)`}
                onChange={(e) =>
                  setCpuLimit(e.target.value ? parseFloat(e.target.value) : null)
                }
              />
              <span className="text-xs text-[var(--color-muted)]">
                Free: {Math.max(0, cap.cpuCores - cap.committedCpu).toFixed(1)} / {cap.cpuCores} cores
              </span>
            </label>
          </div>
        ) : null}

        {pickedRef ? (
          <fieldset className="flex flex-col gap-2">
            <span className="text-sm">GPU</span>
            {!cap.hasGPU ? (
              <div className="rounded-md border border-[var(--color-border)] bg-white/[0.02] p-3 text-xs text-[var(--color-muted)]">
                No NVIDIA GPU detected. Container will run on CPU.
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {(["auto", "specific", "off"] as GpuMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setGpuMode(m)}
                    className={`rounded-md border px-3 py-1.5 text-sm ${
                      gpuMode === m
                        ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10"
                        : "border-[var(--color-border)] hover:bg-white/5"
                    }`}
                  >
                    {m === "auto" ? "Auto-pick" : m === "specific" ? "Pick GPU" : "CPU only"}
                  </button>
                ))}
              </div>
            )}

            {cap.hasGPU && gpuMode === "specific" ? (
              <div className="mt-2 flex flex-col gap-2 rounded-md border border-[var(--color-border)] p-3">
                {cap.gpus.map((g) => {
                  const free = Math.max(0, g.vramFreeGB - g.committedVramGB);
                  return (
                    <button
                      key={g.index}
                      type="button"
                      onClick={() => {
                        setGpuIndex(g.index);
                        setVramAllocGB(Math.min(free, 8));
                      }}
                      className={`flex items-center justify-between rounded border px-3 py-2 text-sm ${
                        gpuIndex === g.index
                          ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10"
                          : "border-[var(--color-border)] hover:bg-white/5"
                      }`}
                    >
                      <span>
                        GPU {g.index} · <span className="text-xs">{g.name}</span>
                      </span>
                      <span className="font-mono text-xs text-[var(--color-muted)]">
                        {free.toFixed(1)} / {g.vramTotalGB.toFixed(1)} GB free
                      </span>
                    </button>
                  );
                })}
                {gpuIndex !== null
                  ? (() => {
                      const g = cap.gpus.find((x) => x.index === gpuIndex);
                      if (!g) return null;
                      const free = Math.max(0, g.vramFreeGB - g.committedVramGB);
                      const val = vramAllocGB ?? Math.min(free, 8);
                      return (
                        <div>
                          <div className="mb-1.5 flex items-center justify-between text-xs uppercase tracking-wide text-[var(--color-muted)]">
                            <span>VRAM allocation</span>
                            <span className="font-mono normal-case text-[var(--color-fg)]">
                              {val.toFixed(1)} GB
                            </span>
                          </div>
                          <input
                            type="range"
                            min={1}
                            max={Math.max(1, free)}
                            step={0.1}
                            value={val}
                            onChange={(e) => setVramAllocGB(parseFloat(e.target.value))}
                            className="w-full"
                          />
                          <div className="mt-1 text-xs text-[var(--color-muted)]">
                            Advisory only — NVIDIA does not enforce per-container VRAM caps.
                          </div>
                        </div>
                      );
                    })()
                  : null}
              </div>
            ) : null}
          </fieldset>
        ) : null}

        {err ? <div className="text-sm text-[var(--color-error)]">{err}</div> : null}

        <Button type="submit" disabled={create.isPending || !fullRef}>
          {create.isPending ? "Provisioning…" : "Host model"}
        </Button>
      </form>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-md border border-[var(--color-border)] p-3">
      <div className="flex items-center justify-between text-xs uppercase tracking-wide text-[var(--color-muted)]">
        {label}
        {icon}
      </div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
      {sub ? <div className="text-xs text-[var(--color-muted)]">{sub}</div> : null}
    </div>
  );
}
