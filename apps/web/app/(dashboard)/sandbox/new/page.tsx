"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Cpu, Download, Key, MemoryStick, Terminal, Zap } from "lucide-react";

const DISTROS = [
  { value: "ubuntu-22.04", label: "Ubuntu 22.04", desc: "LTS, apt, python3" },
  { value: "ubuntu-24.04", label: "Ubuntu 24.04", desc: "Latest LTS" },
  { value: "debian-12", label: "Debian 12", desc: "Stable bookworm" },
  { value: "alpine-3.20", label: "Alpine 3.20", desc: "Minimal, musl libc" },
] as const;

type Distro = (typeof DISTROS)[number]["value"];
type GpuMode = "off" | "auto" | "specific";

export default function NewSandboxPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [distro, setDistro] = useState<Distro>("ubuntu-22.04");
  const [cpuLimit, setCpuLimit] = useState("");
  const [memoryLimit, setMemoryLimit] = useState("");
  const [gpuMode, setGpuMode] = useState<GpuMode>("off");
  const [gpuIndex, setGpuIndex] = useState<number | null>(null);
  const [vramAllocGB, setVramAllocGB] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    projectId: string;
    slug: string;
    privateKey: string;
    sshCommand: string;
  } | null>(null);

  const capQ = trpc.models.capabilities.useQuery();

  const create = trpc.sandbox.create.useMutation({
    onSuccess: (res) => {
      setCreated({
        projectId: res.project.id,
        slug: res.project.slug,
        privateKey: res.privateKey,
        sshCommand: res.sshCommand,
      });
    },
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
      distro,
      cpuLimit: cpuLimit || undefined,
      memoryLimit: memoryLimit || undefined,
      gpu,
    });
  }

  function downloadPrivateKey() {
    if (!created) return;
    const blob = new Blob([created.privateKey], { type: "application/x-pem-file" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `orqestra-sandbox-${created.slug}.pem`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const cap = capQ.data;
  const freeRamGB = cap ? cap.freeRamGB - cap.committedRamGB : 0;
  const freeCpu = cap ? Math.max(0, cap.cpuCores - cap.committedCpu) : 0;
  const freeVramGB = cap
    ? (cap.gpus ?? []).reduce((s, g) => s + Math.max(0, g.vramFreeGB - g.committedVramGB), 0)
    : 0;

  if (created) {
    return (
      <div className="max-w-xl">
        <h1 className="mb-2 text-2xl font-semibold">Sandbox created</h1>
        <p className="mb-6 text-sm text-[var(--color-muted)]">
          Download the private key now — it is shown only once and not stored on the server.
        </p>

        <div className="mb-4 rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5 p-4 text-sm">
          <div className="mb-2 flex items-center gap-2 font-medium">
            <Key className="h-4 w-4" /> Private key (one-time download)
          </div>
          <pre className="mb-3 max-h-48 overflow-auto rounded bg-black/40 p-2 font-mono text-xs">
            {created.privateKey}
          </pre>
          <Button onClick={downloadPrivateKey}>
            <Download className="h-3.5 w-3.5" /> Download .pem
          </Button>
        </div>

        <div className="mb-4 rounded-md border border-[var(--color-border)] p-4 text-sm">
          <div className="mb-2 flex items-center gap-2 font-medium">
            <Terminal className="h-4 w-4" /> Connect
          </div>
          <code className="block break-all rounded bg-white/5 px-2 py-1 font-mono text-xs">
            {created.sshCommand}
          </code>
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            Save the .pem, then <code>chmod 600 &lt;file&gt;.pem</code> before connecting.
          </p>
        </div>

        <Button onClick={() => router.push(`/sandbox/${created.projectId}` as any)}>
          Go to sandbox
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-xl">
      <h1 className="mb-1 text-2xl font-semibold">New sandbox</h1>
      <p className="mb-6 text-sm text-[var(--color-muted)]">
        Linux container with SSH access — host custom models, run scripts, anything you'd do on a
        bare Linux box.
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
          <span className="text-sm">Distro</span>
          <div className="grid grid-cols-2 gap-2">
            {DISTROS.map((d) => (
              <label
                key={d.value}
                className={`cursor-pointer rounded-md border p-3 text-sm ${
                  distro === d.value
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10"
                    : "border-[var(--color-border)] hover:bg-white/5"
                }`}
              >
                <input
                  type="radio"
                  name="distro"
                  value={d.value}
                  checked={distro === d.value}
                  onChange={() => setDistro(d.value)}
                  className="sr-only"
                />
                <div className="font-medium">{d.label}</div>
                <div className="text-xs text-[var(--color-muted)]">{d.desc}</div>
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
              placeholder="auto (e.g. 4G, 8G)"
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
              placeholder="auto (e.g. 2, 4.0)"
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
          {create.isPending ? "Creating…" : "Create sandbox"}
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
