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
const harnessRequirements = `openai-agents[litellm]>=0.0.15
openai>=1.55.0
litellm>=1.55.0
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
import contextvars
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
    from agents.models.openai_chatcompletions import OpenAIChatCompletionsModel
    AGENTS_AVAILABLE = True
except Exception as e:  # noqa: BLE001
    print(f"[harness] openai-agents import failed: {e}", file=sys.stderr)
    AGENTS_AVAILABLE = False

# LiteLLM model adapter — routes the 'provider' backend to Anthropic, Gemini,
# Groq, Mistral, DeepSeek, etc. via their native APIs. Provider keys arrive as
# container env vars (ANTHROPIC_API_KEY, GEMINI_API_KEY, ...) which LiteLLM
# reads automatically.
try:
    from agents.extensions.models.litellm_model import LitellmModel
    LITELLM_AVAILABLE = True
except Exception as e:  # noqa: BLE001
    print(f"[harness] litellm extension import failed: {e}", file=sys.stderr)
    LITELLM_AVAILABLE = False

from openai import AsyncOpenAI

SPEC_PATH = "/etc/orqestra/swarm.json"

# Set per-run so the send_message tool can surface sub-agent replies as
# first-class messages in the outer stream + persist them to the thread.
_current_emit_ctx: contextvars.ContextVar = contextvars.ContextVar(
    "current_emit", default=None
)
_current_req_ctx: contextvars.ContextVar = contextvars.ContextVar(
    "current_req", default=None
)
_current_sender_ctx: contextvars.ContextVar = contextvars.ContextVar(
    "current_sender", default=None
)


def load_spec() -> Dict[str, Any]:
    with open(SPEC_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def model_for(agent_spec: Dict[str, Any]):
    """Build the per-agent Model instance for the openai-agents SDK.

    Three backends:
      - openai   -> OpenAIChatCompletionsModel against api.openai.com
      - local    -> OpenAIChatCompletionsModel against a model_projects apiUrl
                    (resolved by the tRPC router into llm.apiUrl)
      - provider -> LitellmModel("<provider>/<model>"); LiteLLM reads the
                    provider key from the container env (ANTHROPIC_API_KEY,
                    GEMINI_API_KEY, GROQ_API_KEY, ...).
    """
    llm = agent_spec["llm"]
    backend = llm["backend"]
    name = agent_spec.get("name")

    if backend == "openai":
        return OpenAIChatCompletionsModel(
            model=llm["model"],
            openai_client=AsyncOpenAI(),  # picks up OPENAI_API_KEY
        )

    if backend == "local":
        api_url = llm.get("apiUrl")
        if not api_url:
            raise RuntimeError(
                f"local agent {name!r} missing apiUrl — router should resolve it"
            )
        # Local OpenAI-compat endpoints need no key, but the SDK requires one.
        return OpenAIChatCompletionsModel(
            model=llm.get("modelName", "local"),
            openai_client=AsyncOpenAI(base_url=api_url, api_key="local"),
        )

    if backend == "provider":
        if not LITELLM_AVAILABLE:
            raise RuntimeError(
                "litellm extension not installed — cannot use provider backend"
            )
        provider = llm["provider"]
        model = llm["model"]
        # LiteLLM ref format is "<provider>/<model>". Keys come from env.
        return LitellmModel(model=f"{provider}/{model}")

    raise RuntimeError(f"agent {name!r} has unknown llm backend {backend!r}")


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
    # model_for() picks the right adapter per agent backend (openai / local /
    # provider-via-LiteLLM).
    for a in spec.get("agents", []):
        agents_by_name[a["name"]] = Agent(
            name=a["name"],
            instructions=a["instructions"],
            model=model_for(a),
        )

    # Second pass: attach send_message tools + handoff targets per flow.
    by_sender: Dict[str, Dict[str, str]] = {}  # sender -> {receiver -> via}
    for f in flows:
        by_sender.setdefault(f["from"], {})[f["to"]] = f["via"]

    def _make_send_tool(target_agent, target_name: str):
        # Plain closure capture — no leading-underscore default args, since the
        # SDK uses pydantic to build a schema from the function signature and
        # rejects field names with leading underscores.
        async def send_message(message: str) -> str:
            emit = _current_emit_ctx.get()
            req = _current_req_ctx.get()
            caller = _current_sender_ctx.get()

            # Surface the inbound prompt so the UI shows the conversation
            # between agents, not just the final delegation result.
            if emit is not None:
                await emit({
                    "type": "message",
                    "agent": target_name,
                    "role": "user",
                    "text": message,
                    "from": caller,
                })
            if req is not None:
                await _post_thread_append(req, {
                    "threadId": req.threadId,
                    "sender": caller,
                    "receiver": target_name,
                    "role": "user",
                    "content": {"type": "text", "text": message},
                })

            result = await Runner.run(target_agent, message)
            text = result.final_output if result.final_output is not None else ""
            text = text if isinstance(text, str) else str(text)

            # Emit the sub-agent's reply as a top-level message so it lands in
            # the Chat tab and the History panel, not just buried in a tool
            # result blob.
            if emit is not None:
                await emit({
                    "type": "message",
                    "agent": target_name,
                    "role": "assistant",
                    "text": text,
                })
            if req is not None:
                await _post_thread_append(req, {
                    "threadId": req.threadId,
                    "sender": target_name,
                    "receiver": caller,
                    "role": "assistant",
                    "content": {"type": "text", "text": text},
                })
            return text
        send_message.__name__ = f"send_message_to_{target_name}"
        send_message.__doc__ = (
            f"Send a message to the {target_name} agent and return its reply."
        )
        return function_tool(send_message, name_override=f"send_message_to_{target_name}")

    for sender_name, sender in agents_by_name.items():
        targets = by_sender.get(sender_name, {})
        send_tools = []
        handoffs = []
        for receiver_name, via in targets.items():
            receiver = agents_by_name.get(receiver_name)
            if receiver is None:
                continue
            if via == "send_message":
                send_tools.append(_make_send_tool(receiver, receiver_name))
            elif via == "handoff":
                handoffs.append(handoff(agent=receiver))
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


def _call_id_of(item) -> str:
    raw = getattr(item, "raw_item", None)
    if isinstance(raw, dict):
        return raw.get("call_id") or ""
    return getattr(raw, "call_id", "") or ""


def _tool_output_summary(item, call_names: Dict[str, str]) -> Dict[str, Any]:
    raw = getattr(item, "raw_item", None)
    name = call_names.get(_call_id_of(item), "")
    if not name:
        name = getattr(raw, "name", None) if not isinstance(raw, dict) else raw.get("name")
        name = name or "tool"
    output = getattr(item, "output", None)
    if output is None:
        if isinstance(raw, dict):
            output = raw.get("output")
        else:
            output = getattr(raw, "output", None)
    return {"name": name, "result": output}


async def _run_swarm(req: RunRequest, spec: Dict[str, Any], emit):
    entry = spec["orchestration"]["entryAgent"]
    agents_by_name = _build_agents(spec)
    entry_agent = agents_by_name.get(entry)
    if entry_agent is None:
        raise RuntimeError(f"entry agent {entry!r} not in built agents")

    # Publish context for the send_message tool wrappers to use.
    emit_tok = _current_emit_ctx.set(emit)
    req_tok = _current_req_ctx.set(req)
    sender_tok = _current_sender_ctx.set(entry)
    try:
        await emit({"type": "run_start", "runId": req.runId, "entryAgent": entry})

        stream = Runner.run_streamed(entry_agent, req.userMessage)
        current_agent = entry
        call_names: Dict[str, str] = {}

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
                    _current_sender_ctx.set(new_name)
                    await emit({"type": "agent_updated", "agent": new_name})
                continue

            if e_type == "run_item_stream_event":
                item = getattr(event, "item", None)
                if item is None:
                    continue
                item_type = getattr(item, "type", "unknown")
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
                    call_id = _call_id_of(item)
                    if call_id:
                        call_names[call_id] = summary["name"]
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
                            "id": call_id,
                            "name": summary["name"],
                            "args": summary["args"],
                        }],
                    })
                elif item_type == "tool_call_output_item":
                    summary = _tool_output_summary(item, call_names)
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
                    source = getattr(getattr(item, "source_agent", None), "name", None)
                    target = getattr(getattr(item, "target_agent", None), "name", None)
                    await emit({
                        "type": "handoff",
                        "from": source or item_agent,
                        "to": target,
                    })
                elif item_type == "reasoning_item":
                    await emit({"type": "reasoning", "agent": item_agent})
                continue

            await emit({"type": "unknown_event", "kind": e_type or "unset"})

        final_output = getattr(stream, "final_output", None)
        if final_output is not None:
            text = str(final_output)
            await emit({"type": "run_final", "text": text, "agent": current_agent})

        await emit({"type": "run_end", "runId": req.runId})
    finally:
        _current_emit_ctx.reset(emit_tok)
        _current_req_ctx.reset(req_tok)
        _current_sender_ctx.reset(sender_tok)


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
