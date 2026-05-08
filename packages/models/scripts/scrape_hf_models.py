#!/usr/bin/env python3
"""Scrape HF metadata for curated text-generation models.

Outputs `packages/models/data/hf_models.json`. Hourly refresher in apps/api
spawns this via Bun.spawn.

The full curated list (700+ lines) lives in BUILDER notes — paste it into
TARGET_MODELS to extend coverage. This trimmed version covers the seed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

HF_API = "https://huggingface.co/api/models"

TARGET_MODELS = [
    "Qwen/Qwen2.5-0.5B-Instruct",
    "Qwen/Qwen2.5-1.5B-Instruct",
    "Qwen/Qwen2.5-3B-Instruct",
    "Qwen/Qwen2.5-7B-Instruct",
    "Qwen/Qwen2.5-14B-Instruct",
    "Qwen/Qwen2.5-Coder-7B-Instruct",
    "meta-llama/Llama-3.2-1B-Instruct",
    "meta-llama/Llama-3.2-3B-Instruct",
    "meta-llama/Llama-3.1-8B-Instruct",
    "google/gemma-2-2b-it",
    "google/gemma-3-4b-it",
    "microsoft/Phi-3.5-mini-instruct",
    "microsoft/Phi-4-mini-instruct",
    "mistralai/Mistral-7B-Instruct-v0.3",
    "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
]

QUANT_BPP_Q4 = 0.5
RUNTIME_OVERHEAD = 1.2


def _headers() -> dict[str, str]:
    h = {"User-Agent": "orqestra-scrape/1"}
    tok = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if tok:
        h["Authorization"] = f"Bearer {tok}"
    return h


def fetch_model_info(repo_id: str) -> dict | None:
    req = urllib.request.Request(f"{HF_API}/{repo_id}", headers=_headers())
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"  [skip] HTTP {e.code} for {repo_id}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"  [skip] {repo_id}: {e}", file=sys.stderr)
        return None


def fetch_config(repo_id: str) -> dict | None:
    url = f"https://huggingface.co/{repo_id}/resolve/main/config.json"
    req = urllib.request.Request(url, headers=_headers())
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except Exception:
        return None


def fmt_params(n: int) -> str:
    if n >= 1_000_000_000:
        v = n / 1_000_000_000
        return f"{v:.1f}B" if v != int(v) else f"{int(v)}B"
    if n >= 1_000_000:
        return f"{n / 1_000_000:.0f}M"
    return f"{n / 1_000:.0f}K"


def estimate_ram(total_params: int) -> tuple[float, float, float]:
    size_gb = (total_params * QUANT_BPP_Q4) / (1024**3)
    min_ram = max(size_gb * RUNTIME_OVERHEAD, 1.0)
    rec_ram = max(size_gb * 2.0, 2.0)
    vram = max(size_gb * 1.1, 0.5)
    return round(min_ram, 1), round(rec_ram, 1), round(vram, 1)


def context_length(cfg: dict | None) -> int:
    if not cfg:
        return 4096
    for k in ("max_position_embeddings", "max_sequence_length", "n_positions"):
        v = cfg.get(k)
        if isinstance(v, int) and v > 0:
            return v
    return 4096


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=None, help="Output path; defaults to ../data/hf_models.json")
    args = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    out_path = args.out or os.path.join(here, "..", "data", "hf_models.json")

    rows: list[dict] = []
    for repo_id in TARGET_MODELS:
        info = fetch_model_info(repo_id)
        if not info:
            continue
        st = info.get("safetensors", {})
        total = st.get("total")
        if not total:
            params = st.get("parameters", {})
            if params:
                total = max(params.values())
        if not total:
            print(f"  [skip] no params for {repo_id}", file=sys.stderr)
            continue

        cfg = fetch_config(repo_id)
        min_ram, rec_ram, vram = estimate_ram(total)
        rows.append({
            "name": repo_id,
            "parameters_raw": total,
            "parameter_count": fmt_params(total),
            "min_ram_gb": min_ram,
            "recommended_ram_gb": rec_ram,
            "min_vram_gb": vram,
            "context_length": context_length(cfg),
            "architecture": (cfg or {}).get("model_type", "unknown"),
            "pipeline_tag": info.get("pipeline_tag", "text-generation"),
            "hf_downloads": info.get("downloads", 0),
            "hf_likes": info.get("likes", 0),
            "release_date": (info.get("createdAt") or "")[:10] or None,
        })
        print(f"  [ok] {repo_id} {fmt_params(total)} ({min_ram} GB)")

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(rows, f, indent=2)
    print(f"wrote {len(rows)} models to {out_path}")


if __name__ == "__main__":
    main()
