import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogSchema, type Catalog, type CatalogModel, type RuntimeOption } from "./types";
import { seedCatalog } from "./catalog";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const SCRIPTS_DIR = join(PKG_ROOT, "scripts");
const DATA_DIR = join(PKG_ROOT, "data");
const HF_OUT = join(DATA_DIR, "hf_models.json");
const DMR_OUT = join(DATA_DIR, "docker_models.json");

interface HfRow {
  name: string;
  parameters_raw: number;
  parameter_count: string;
  min_ram_gb: number;
  recommended_ram_gb: number;
  min_vram_gb: number;
  context_length: number;
  architecture: string;
  pipeline_tag: string;
  hf_downloads: number;
  hf_likes: number;
  release_date: string | null;
}

interface DmrRow {
  repo: string;
  available_tags: string[];
}

interface RefreshOptions {
  pythonBin?: string;
  /** When true, skip running the Python scripts and just merge whatever
   *  JSON files are already on disk. */
  reuseExisting?: boolean;
}

export async function refreshCatalog(opts: RefreshOptions = {}): Promise<Catalog> {
  const python = opts.pythonBin ?? process.env.ORQESTRA_PYTHON ?? "python3";

  if (!opts.reuseExisting) {
    await runScraper(python, "scrape_hf_models.py");
    await runScraper(python, "scrape_docker_models.py");
  }

  const [hfRows, dmrRows] = await Promise.all([
    readJson<HfRow[]>(HF_OUT),
    readJson<DmrRow[]>(DMR_OUT),
  ]);
  const dmrSet = new Set((dmrRows ?? []).map((r) => r.repo));

  const merged = mergeCatalog(hfRows ?? [], dmrSet);
  return catalogSchema.parse({
    version: 1,
    generatedAt: new Date().toISOString(),
    models: merged,
  });
}

async function runScraper(python: string, script: string): Promise<void> {
  const path = join(SCRIPTS_DIR, script);
  if (!existsSync(path)) throw new Error(`scraper missing: ${path}`);

  // @ts-expect-error - Bun is global at runtime, missing on Node.
  const bunGlobal: any = typeof Bun !== "undefined" ? Bun : null;
  if (bunGlobal && typeof bunGlobal.spawn === "function") {
    const proc = bunGlobal.spawn([python, path], {
      cwd: SCRIPTS_DIR,
      stderr: "inherit",
      stdout: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`${script} exited ${code}`);
    return;
  }
  const { spawn } = await import("node:child_process");
  await new Promise<void>((res, rej) => {
    const child = spawn(python, [path], { cwd: SCRIPTS_DIR, stdio: "inherit" });
    child.on("error", rej);
    child.on("exit", (code) =>
      code === 0 ? res() : rej(new Error(`${script} exited ${code}`)),
    );
  });
}

async function readJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * Merge HF metadata + DMR repo presence with the seed list. Seed catalog
 * is the source of truth for runtime references (Ollama tag, DMR tag);
 * HF rows enrich with live param counts / download stats; DMR presence
 * trims runtimes that no longer exist on Docker Hub.
 */
function mergeCatalog(hfRows: HfRow[], dmrSet: Set<string>): CatalogModel[] {
  const hfByRepo = new Map(hfRows.map((r) => [r.name.toLowerCase(), r]));
  const seedByRepo = new Map(
    seedCatalog.models.map((m) => [m.hfRepo.toLowerCase(), m]),
  );

  const out: CatalogModel[] = [];

  for (const seed of seedCatalog.models) {
    const hf = hfByRepo.get(seed.hfRepo.toLowerCase());
    const runtimes = filterDmrRuntimes(seed.runtimes, dmrSet);
    out.push({
      ...seed,
      ...(hf
        ? {
            parametersRaw: hf.parameters_raw,
            parameterCount: hf.parameter_count,
            minRamGB: hf.min_ram_gb,
            recommendedRamGB: hf.recommended_ram_gb,
            minVramGB: hf.min_vram_gb,
            contextLength: hf.context_length,
            architecture: hf.architecture,
            pipelineTag: hf.pipeline_tag,
            hfDownloads: hf.hf_downloads,
            hfLikes: hf.hf_likes,
            releaseDate: seed.releaseDate ?? hf.release_date,
          }
        : {}),
      runtimes: runtimes.length > 0 ? runtimes : seed.runtimes,
      updatedAt: new Date().toISOString(),
    });
  }

  // Add HF-only rows not in the seed (best-effort discovery).
  for (const hf of hfRows) {
    const lower = hf.name.toLowerCase();
    if (seedByRepo.has(lower)) continue;
    out.push(synthFromHf(hf));
  }

  return out;
}

function filterDmrRuntimes(
  runtimes: RuntimeOption[],
  dmrSet: Set<string>,
): RuntimeOption[] {
  return runtimes.filter((r) => {
    if (r.kind !== "docker-model-runner") return true;
    const repo = r.reference.replace(/^ai\//, "").split(":")[0]!;
    return dmrSet.has(repo);
  });
}

function synthFromHf(hf: HfRow): CatalogModel {
  const id = hf.name.toLowerCase();
  const ollamaTag = id.split("/").pop() ?? id;
  return {
    id,
    name: hf.name,
    provider: hf.name.split("/")[0] ?? "Unknown",
    parameterCount: hf.parameter_count,
    parametersRaw: hf.parameters_raw,
    activeParameters: hf.parameters_raw,
    isMoe: false,
    minRamGB: hf.min_ram_gb,
    recommendedRamGB: hf.recommended_ram_gb,
    minVramGB: hf.min_vram_gb,
    contextLength: hf.context_length,
    capabilities: [],
    useCase: "discovered from HF",
    pipelineTag: hf.pipeline_tag,
    architecture: hf.architecture,
    hfRepo: hf.name,
    hfDownloads: hf.hf_downloads,
    hfLikes: hf.hf_likes,
    releaseDate: hf.release_date,
    runtimes: [{ kind: "ollama", reference: ollamaTag }],
    updatedAt: new Date().toISOString(),
  };
}
