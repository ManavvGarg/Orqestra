"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Cpu, MemoryStick, Zap } from "lucide-react";

const RUNTIMES = [
  { value: "base", label: "Base Python", desc: "Minimal Jupyter + numpy/pandas" },
  { value: "tensorflow", label: "TensorFlow", desc: "GPU-ready TF stack" },
  { value: "pytorch", label: "PyTorch", desc: "PyTorch + torchvision" },
  { value: "r", label: "R", desc: "R kernel + tidyverse" },
] as const;

type GpuMode = "off" | "auto" | "specific";

export default function NewJupyterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [jobType, setJobType] = useState<(typeof RUNTIMES)[number]["value"]>("base");
  const [cpuLimit, setCpuLimit] = useState("");
  const [memoryLimit, setMemoryLimit] = useState("");
  const [gpuMode, setGpuMode] = useState<GpuMode>("off");
  const [gpuIndex, setGpuIndex] = useState<number | null>(null);
  const [vramAllocGB, setVramAllocGB] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const capQ = trpc.models.capabilities.useQuery();

  const create = trpc.jupyter.create.useMutation({
    onSuccess: (project) => router.push(`/jupyter/${project.id}` as any),
    onError: (e) => setErr(e.message),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
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
      jobType,
      cpuLimit: cpuLimit || undefined,
      memoryLimit: memoryLimit || undefined,
      gpu,
    });
  }

  const cap = capQ.data;
  const freeRamGB = cap ? cap.freeRamGB - cap.committedRamGB : 0;
  const freeCpu = cap ? Math.max(0, cap.cpuCores - cap.committedCpu) : 0;
  const freeVramGB = cap
    ? cap.gpus.reduce((s, g) => s + Math.max(0, g.vramFreeGB - g.committedVramGB), 0)
    : 0;

  return (
    <div className="max-w-xl">
      <h1 className="mb-1 text-2xl font-semibold">New Jupyter project</h1>
      <p className="mb-6 text-sm text-[var(--color-muted)]">
        Isolated container with persistent volume. Pick CPU/RAM/GPU limits.
      </p>

      {cap ? (
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
            sub={`${freeCpu.toFixed(1)} free`}
          />
          <Stat
            icon={<Zap className="h-4 w-4" />}
            label="GPUs"
            value={cap.hasGPU ? `${cap.gpus.length}` : "none"}
            sub={cap.hasGPU ? `${freeVramGB.toFixed(1)} GB VRAM free` : "CPU-only"}
          />
        </div>
      ) : null}

      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
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

        <fieldset className="flex flex-col gap-2">
          <span className="text-sm">Runtime</span>
          <div className="grid grid-cols-2 gap-2">
            {RUNTIMES.map((r) => (
              <label
                key={r.value}
                className={`cursor-pointer rounded-md border p-3 text-sm ${
                  jobType === r.value
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10"
                    : "border-[var(--color-border)] hover:bg-white/5"
                }`}
              >
                <input
                  type="radio"
                  name="runtime"
                  value={r.value}
                  checked={jobType === r.value}
                  onChange={() => setJobType(r.value)}
                  className="sr-only"
                />
                <div className="font-medium">{r.label}</div>
                <div className="text-xs text-[var(--color-muted)]">{r.desc}</div>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm">RAM limit — optional</span>
            <Input
              value={memoryLimit}
              onChange={(e) => setMemoryLimit(e.target.value)}
              placeholder="auto (e.g. 4G, 8G, 16384M)"
            />
            <span className="text-xs text-[var(--color-muted)]">
              {cap ? `Free: ${freeRamGB.toFixed(1)} / ${cap.totalRamGB.toFixed(1)} GB` : "—"}
            </span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm">CPU cores — optional</span>
            <Input
              value={cpuLimit}
              onChange={(e) => setCpuLimit(e.target.value)}
              placeholder="auto (e.g. 2, 4.0, 0.5)"
            />
            <span className="text-xs text-[var(--color-muted)]">
              {cap ? `Free: ${freeCpu.toFixed(1)} / ${cap.cpuCores} cores` : "—"}
            </span>
          </label>
        </div>

        <fieldset className="flex flex-col gap-2">
          <span className="text-sm">GPU</span>
          {!cap?.hasGPU ? (
            <div className="rounded-md border border-[var(--color-border)] bg-white/[0.02] p-3 text-xs text-[var(--color-muted)]">
              No NVIDIA GPU available. Container will run on CPU.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {(["off", "auto", "specific"] as GpuMode[]).map((m) => (
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
                    {m === "off" ? "CPU only" : m === "auto" ? "Auto-pick" : "Pick GPU"}
                  </button>
                ))}
              </div>

              {gpuMode === "specific" ? (
                <div className="mt-2 flex flex-col gap-2 rounded-md border border-[var(--color-border)] p-3">
                  {cap.gpus.map((g) => {
                    const free = Math.max(0, g.vramFreeGB - g.committedVramGB);
                    return (
                      <button
                        key={g.index}
                        type="button"
                        onClick={() => {
                          setGpuIndex(g.index);
                          setVramAllocGB(Math.min(free, 4));
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
                        const val = vramAllocGB ?? Math.min(free, 4);
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
            </>
          )}
        </fieldset>

        {err ? <div className="text-sm text-[var(--color-error)]">{err}</div> : null}
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? "Creating…" : "Create project"}
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
