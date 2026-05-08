import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./system-prompt";
import { buildTools, type AgentRunState, type ProposedFix } from "./tools";
import { log } from "../lib/log";
import { confirm, bail } from "../ui/prompts";
import { sh } from "../lib/shell";

interface DiagnoseInput {
  apiKey: string;
  installDir: string;
  failedStep: { id: string; title: string };
  error: string;
  stdout?: string;
  stderr?: string;
  installMode: "local" | "server";
  siteDomain: string;
}

export async function diagnoseAndFix(input: DiagnoseInput): Promise<"applied" | "skipped" | "failed"> {
  const client = new Anthropic({ apiKey: input.apiKey });
  const state: AgentRunState = { installDir: input.installDir, proposedFix: null };
  const tools = buildTools(state);

  const userMessage = [
    `Step "${input.failedStep.title}" (id: ${input.failedStep.id}) failed.`,
    ``,
    `Mode: ${input.installMode}. Domain: ${input.siteDomain}. Install dir: ${input.installDir}.`,
    ``,
    `Error:`,
    input.error,
    input.stdout ? `\n--- stdout (last) ---\n${tail(input.stdout, 2000)}` : "",
    input.stderr ? `\n--- stderr (last) ---\n${tail(input.stderr, 2000)}` : "",
    ``,
    `Diagnose the root cause and propose a fix. Investigate first; don't guess.`,
  ]
    .filter(Boolean)
    .join("\n");

  log.info("Asking Claude to diagnose…");

  try {
    const finalMessage = await client.beta.messages.toolRunner({
      model: "claude-opus-4-7",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools,
      messages: [{ role: "user", content: userMessage }],
      max_iterations: 8,
    });

    const usage = finalMessage.usage;
    log.info(
      `Claude used ${usage.input_tokens} input + ${usage.output_tokens} output tokens` +
        (usage.cache_read_input_tokens
          ? ` (cache hit: ${usage.cache_read_input_tokens})`
          : ""),
    );
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      log.err(`Anthropic API error ${err.status}: ${err.message}`);
    } else {
      log.err(`Diagnostic agent failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return "failed";
  }

  const fix = state.proposedFix;
  if (!fix) {
    log.warn("Agent did not produce a fix proposal. Skipping.");
    return "skipped";
  }

  return await presentAndApply(fix, input.installDir);
}

async function presentAndApply(fix: ProposedFix, installDir: string): Promise<"applied" | "skipped" | "failed"> {
  console.log();
  log.raw("  Diagnosis: " + fix.diagnosis);
  log.raw("  " + fix.explanation);
  console.log();

  if (fix.commands.length === 0) {
    log.warn("Agent could not produce a fix. Original error stands.");
    return "skipped";
  }

  log.raw("  Proposed commands:");
  fix.commands.forEach((c, i) => log.raw(`    ${i + 1}. ${c}`));
  if (fix.destructive) {
    log.warn("This fix is marked DESTRUCTIVE. Read carefully before approving.");
  }
  console.log();

  const ok = await confirm({
    message: "Apply these commands?",
    initialValue: !fix.destructive,
  });
  bail(ok);
  if (!ok) return "skipped";

  for (const [i, cmd] of fix.commands.entries()) {
    log.info(`Apply ${i + 1}/${fix.commands.length}: ${cmd}`);
    const r = await sh(cmd, { cwd: installDir, inherit: true, timeoutMs: 30 * 60 * 1000 });
    if (!r.ok) {
      log.err(`Command failed (exit ${r.exitCode}): ${cmd}`);
      return "failed";
    }
  }
  log.ok("Fix applied. Retrying the failed step…");
  return "applied";
}

function tail(s: string, n: number): string {
  return s.length > n ? "…" + s.slice(-n) : s;
}
