package main

// Files embedded as build context for the harness image. The orchestrator
// writes them into a tarball at startup and feeds it to docker ImageBuild.

const harnessDockerfile = `FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DEFAULT_TIMEOUT=120
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN python -m pip install --upgrade pip
COPY requirements.txt /app/requirements.txt
RUN pip install --verbose -r /app/requirements.txt
COPY main.py /app/main.py
EXPOSE 7000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7000"]
`

// Pin to verified-published versions. openai-agents on PyPI as of late 2025
// has releases in the 0.0.x line; using a floor pin keeps us forward-compatible
// while exposing breaking changes loudly via the harness event handler.
const harnessRequirements = `openai-agents>=0.0.15
openai>=1.55.0
fastapi>=0.115.0
uvicorn>=0.30.0
httpx>=0.27.0
pydantic>=2.7.0
`

const harnessPython = `"""
Orqestra AgentHive harness.

Reads /etc/orqestra/swarm.json on startup, builds a graph of Agent instances
wired together by the spec's communicationFlows, and exposes:

  GET  /health  -> {"ok": true}
  POST /run     -> SSE stream of agent events (one JSON object per line)

Each agent message is also POST'd to ${apiCallbackBase}/internal/agenthive/thread-append
for Postgres persistence.
"""
import asyncio
import json
import os
import sys
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

try:
    from agents import Agent, Runner, function_tool, handoff
    from agents.models.openai_provider import OpenAIProvider
    AGENTS_AVAILABLE = True
except Exception as e:  # noqa: BLE001
    print(f"[harness] openai-agents import failed: {e}", file=sys.stderr)
    AGENTS_AVAILABLE = False

from openai import AsyncOpenAI

SPEC_PATH = "/etc/orqestra/swarm.json"


def load_spec() -> Dict[str, Any]:
    with open(SPEC_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def llm_client_for(agent_spec: Dict[str, Any]) -> AsyncOpenAI:
    """Return an AsyncOpenAI client pointed at the right backend.
    The tRPC router resolves model_projects.apiUrl into llm.apiUrl before
    writing /etc/orqestra/swarm.json, so the harness uses it directly.
    """
    llm = agent_spec["llm"]
    if llm["backend"] == "openai":
        return AsyncOpenAI()  # picks up OPENAI_API_KEY
    api_url = llm.get("apiUrl")
    if not api_url:
        raise RuntimeError(
            f"local agent {agent_spec.get('name')!r} missing apiUrl — "
            "router should have resolved this"
        )
    # Local OpenAI-compat endpoints don't need a key, but the SDK requires one.
    return AsyncOpenAI(base_url=api_url, api_key="local")


def llm_model_name(agent_spec: Dict[str, Any]) -> str:
    llm = agent_spec["llm"]
    if llm["backend"] == "openai":
        return llm["model"]
    # For local backends the apiUrl already targets a specific model; pass a
    # neutral identifier. Ollama ignores it; DMR routes by the path prefix.
    return llm.get("modelName", "local")


class RunRequest(BaseModel):
    runId: str
    threadId: str
    swarmId: str
    userMessage: str
    apiCallbackBase: str
    internalSecret: str


app = FastAPI()
_spec: Optional[Dict[str, Any]] = None


@app.on_event("startup")
async def _startup() -> None:
    global _spec
    try:
        _spec = load_spec()
        print(f"[harness] loaded spec: {len(_spec.get('agents', []))} agents", flush=True)
    except FileNotFoundError:
        print("[harness] no spec at " + SPEC_PATH, file=sys.stderr, flush=True)


@app.get("/health")
async def health() -> Dict[str, Any]:
    return {"ok": True, "ready": _spec is not None}


async def _post_thread_append(req: RunRequest, payload: Dict[str, Any]) -> None:
    url = req.apiCallbackBase.rstrip("/") + "/internal/agenthive/thread-append"
    headers = {"X-Internal-Secret": req.internalSecret, "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(url, json=payload, headers=headers)
    except Exception as e:  # noqa: BLE001
        print(f"[harness] thread-append failed: {e}", file=sys.stderr, flush=True)


def _build_agents(spec: Dict[str, Any]) -> Dict[str, "Agent"]:
    """Map agent name -> Agent instance. Wires send_message + handoff per flows."""
    if not AGENTS_AVAILABLE:
        raise RuntimeError("openai-agents SDK not installed in harness image")

    agents_by_name: Dict[str, Agent] = {}
    flows: List[Dict[str, str]] = spec.get("communicationFlows", [])

    # First pass: build bare Agent instances so we can reference them in tools.
    for a in spec.get("agents", []):
        model_client = llm_client_for(a)
        provider = OpenAIProvider(openai_client=model_client)
        agents_by_name[a["name"]] = Agent(
            name=a["name"],
            instructions=a["instructions"],
            model=llm_model_name(a),
            model_provider=provider,
        )

    # Second pass: attach send_message tools + handoff targets per flow.
    by_sender: Dict[str, Dict[str, str]] = {}  # sender -> {receiver -> via}
    for f in flows:
        by_sender.setdefault(f["from"], {})[f["to"]] = f["via"]

    for sender_name, sender in agents_by_name.items():
        targets = by_sender.get(sender_name, {})
        send_tools = []
        handoffs = []
        for receiver_name, via in targets.items():
            receiver = agents_by_name.get(receiver_name)
            if receiver is None:
                continue
            if via == "send_message":
                # Bind receiver into a closure so the tool can call it.
                async def _send(message: str, _receiver=receiver, _receiver_name=receiver_name):
                    result = await Runner.run(_receiver, message)
                    return result.final_output or ""
                _send.__name__ = f"send_message_to_{receiver_name}"
                send_tools.append(function_tool(_send, name_override=f"send_message_to_{receiver_name}"))
            elif via == "handoff":
                handoffs.append(handoff(agent=receiver))
        # Mutate the agent in place via re-construction since Agent is dataclass-ish.
        sender.tools = list(getattr(sender, "tools", [])) + send_tools
        sender.handoffs = list(getattr(sender, "handoffs", [])) + handoffs

    return agents_by_name


def _extract_text_from_message_item(item) -> str:
    """Pull plain text out of a MessageOutputItem.
    SDK 0.0.20 stores the message under item.raw_item (a ResponseOutputMessage
    with a .content list). We flatten any text parts.
    """
    raw = getattr(item, "raw_item", None)
    if raw is None:
        return ""
    content = getattr(raw, "content", None)
    if content is None:
        return ""
    parts: List[str] = []
    for part in content:
        # ResponseOutputText has .text; refusal/other types are skipped.
        t = getattr(part, "text", None)
        if t:
            parts.append(t)
    return "".join(parts)


def _tool_call_summary(item) -> Dict[str, Any]:
    raw = getattr(item, "raw_item", None)
    name = getattr(raw, "name", None) or getattr(item, "name", None) or "tool"
    args = getattr(raw, "arguments", None) or getattr(item, "arguments", None) or ""
    try:
        parsed = json.loads(args) if isinstance(args, str) else (args or {})
    except json.JSONDecodeError:
        parsed = {"_raw": args}
    return {"name": name, "args": parsed}


def _tool_output_summary(item) -> Dict[str, Any]:
    raw = getattr(item, "raw_item", None)
    name = getattr(raw, "name", None) or "tool"
    output = getattr(item, "output", None)
    if output is None:
        output = getattr(raw, "output", None)
    return {"name": name, "result": output}


async def _run_swarm(req: RunRequest, spec: Dict[str, Any], emit):
    entry = spec["orchestration"]["entryAgent"]
    agents_by_name = _build_agents(spec)
    entry_agent = agents_by_name.get(entry)
    if entry_agent is None:
        raise RuntimeError(f"entry agent {entry!r} not in built agents")

    await emit({"type": "run_start", "runId": req.runId, "entryAgent": entry})

    stream = Runner.run_streamed(entry_agent, req.userMessage)
    current_agent = entry

    async for event in stream.stream_events():
        e_type = getattr(event, "type", None)

        # Skip the high-volume token-level raw events for v0 — UI only needs
        # whole-message granularity per the plan.
        if e_type == "raw_response_event":
            continue

        if e_type == "agent_updated_stream_event":
            new_agent = getattr(event, "new_agent", None)
            new_name = getattr(new_agent, "name", None)
            if new_name:
                current_agent = new_name
                await emit({"type": "agent_updated", "agent": new_name})
            continue

        if e_type == "run_item_stream_event":
            item = getattr(event, "item", None)
            if item is None:
                continue
            item_type = getattr(item, "type", "unknown")
            # The current acting agent is on the item itself.
            item_agent = getattr(getattr(item, "agent", None), "name", None) or current_agent

            if item_type == "message_output_item":
                text = _extract_text_from_message_item(item)
                if text:
                    await emit({
                        "type": "message",
                        "agent": item_agent,
                        "role": "assistant",
                        "text": text,
                    })
                    await _post_thread_append(req, {
                        "threadId": req.threadId,
                        "sender": item_agent,
                        "receiver": None,
                        "role": "assistant",
                        "content": {"type": "text", "text": text},
                    })
            elif item_type == "tool_call_item":
                summary = _tool_call_summary(item)
                await emit({
                    "type": "tool_call",
                    "agent": item_agent,
                    "name": summary["name"],
                    "args": summary["args"],
                })
                await _post_thread_append(req, {
                    "threadId": req.threadId,
                    "sender": item_agent,
                    "receiver": None,
                    "role": "assistant",
                    "content": {
                        "type": "tool_call",
                        "name": summary["name"],
                        "args": summary["args"],
                    },
                    "toolCalls": [{
                        "id": getattr(getattr(item, "raw_item", None), "call_id", "") or "",
                        "name": summary["name"],
                        "args": summary["args"],
                    }],
                })
            elif item_type == "tool_call_output_item":
                summary = _tool_output_summary(item)
                await emit({
                    "type": "tool_output",
                    "agent": item_agent,
                    "name": summary["name"],
                    "result": summary["result"],
                })
                await _post_thread_append(req, {
                    "threadId": req.threadId,
                    "sender": "tool",
                    "receiver": item_agent,
                    "role": "tool",
                    "content": {
                        "type": "tool_result",
                        "name": summary["name"],
                        "result": summary["result"],
                    },
                })
            elif item_type == "handoff_call_item":
                summary = _tool_call_summary(item)
                await emit({
                    "type": "handoff_call",
                    "agent": item_agent,
                    "target": summary["name"],
                    "args": summary["args"],
                })
            elif item_type == "handoff_output_item":
                # SDK exposes source + target agents on the handoff output item.
                source = getattr(getattr(item, "source_agent", None), "name", None)
                target = getattr(getattr(item, "target_agent", None), "name", None)
                await emit({
                    "type": "handoff",
                    "from": source or item_agent,
                    "to": target,
                })
            elif item_type == "reasoning_item":
                # Visible reasoning summary (o-series models). Skip persistence
                # to keep the thread compact but emit for live view.
                await emit({"type": "reasoning", "agent": item_agent})
            continue

        # Unknown event type — emit minimal record for debugging without
        # crashing on schema drift.
        await emit({"type": "unknown_event", "kind": e_type or "unset"})

    final_output = getattr(stream, "final_output", None)
    if final_output is not None:
        text = str(final_output)
        await emit({"type": "run_final", "text": text, "agent": current_agent})

    await emit({"type": "run_end", "runId": req.runId})


@app.post("/run")
async def run(req: RunRequest):
    if _spec is None:
        raise HTTPException(503, "spec not loaded")
    if not AGENTS_AVAILABLE:
        raise HTTPException(500, "openai-agents not installed")

    queue: asyncio.Queue[Optional[Dict[str, Any]]] = asyncio.Queue()

    async def emit(ev: Dict[str, Any]) -> None:
        await queue.put(ev)

    async def runner_task():
        try:
            await _run_swarm(req, _spec, emit)
        except Exception as e:  # noqa: BLE001
            await emit({"type": "error", "message": str(e)})
        finally:
            await queue.put(None)

    asyncio.create_task(runner_task())

    async def streamer():
        while True:
            ev = await queue.get()
            if ev is None:
                break
            yield "data: " + json.dumps(ev) + "\n\n"

    return StreamingResponse(streamer(), media_type="text/event-stream")
`
