#!/usr/bin/env python3
"""Scrape Docker Model Runner ai/ namespace.

Outputs `packages/models/data/docker_models.json` — list of
{repo, available_tags}.

Cross-reference with hf_models.json happens in TS merger.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DOCKER_HUB_API = "https://hub.docker.com/v2/repositories/ai/"
PAGE_SIZE = 100


def fetch_repos() -> list[str]:
    repos: list[str] = []
    url: str | None = f"{DOCKER_HUB_API}?page_size={PAGE_SIZE}"
    while url:
        req = urllib.request.Request(url, headers={"User-Agent": "orqestra-scrape/1"})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode())
        except (urllib.error.URLError, urllib.error.HTTPError) as e:
            print(f"  [err] {url}: {e}", file=sys.stderr)
            break
        for r in data.get("results", []):
            name = r.get("name", "")
            if name and not name.endswith(("-vllm", "-safetensors")):
                repos.append(name)
        url = data.get("next")
    return repos


def fetch_tags(repo: str) -> list[str]:
    url = f"{DOCKER_HUB_API}{repo}/tags/?page_size=100"
    req = urllib.request.Request(url, headers={"User-Agent": "orqestra-scrape/1"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
    except Exception:
        return []
    return [t["name"] for t in data.get("results", []) if t.get("name")]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=None, help="Output path; defaults to ../data/docker_models.json")
    args = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    out_path = args.out or os.path.join(here, "..", "data", "docker_models.json")

    repos = fetch_repos()
    print(f"found {len(repos)} ai/ repos")

    rows: list[dict] = []
    for repo in sorted(repos):
        tags = fetch_tags(repo)
        rows.append({"repo": repo, "available_tags": tags})
        print(f"  ai/{repo}: {len(tags)} tags")

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(rows, f, indent=2)
    print(f"wrote {len(rows)} repos to {out_path}")


if __name__ == "__main__":
    main()
