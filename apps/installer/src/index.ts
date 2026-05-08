#!/usr/bin/env bun
import kleur from "kleur";
import { log } from "./lib/log";
import { collectConfig } from "./collect-config";
import { allSteps } from "./steps";
import { diagnoseAndFix } from "./agent/diagnose";
import { saveState, loadState } from "./lib/state";
import { confirm, select, bail } from "./ui/prompts";
import type { InstallConfig, Step, StepContext } from "./types";

async function main() {
  log.banner();

  const config = await collectConfig();

  // Filter steps by config (server-only / GPU-only / DNS-mode-specific drop out).
  const steps = allSteps.filter((s) => (s.appliesTo ? s.appliesTo(config) : true));

  const ctx: StepContext = {
    config,
    installDir: config.installDir,
    state: {},
  };

  const prior = await loadState(config.installDir);
  const completed = new Set(prior?.completedSteps ?? []);
  if (prior && completed.size > 0) {
    const resume = await confirm({
      message: `Found ${completed.size} previously-completed steps in ${config.installDir}. Resume?`,
      initialValue: true,
    });
    bail(resume);
    if (!resume) completed.clear();
  }

  log.section(`Running ${steps.length} steps`);

  const total = steps.length;
  let i = 0;
  for (const step of steps) {
    i++;
    if (completed.has(step.id)) {
      log.step(i, total, kleur.gray(`${step.title} — skipped (already done)`));
      continue;
    }
    log.step(i, total, step.title);
    const ok = await runStepWithRecovery(step, ctx, config);
    if (!ok) {
      log.err("Aborting. State saved — re-run the installer to resume.");
      await saveState({
        completedSteps: Array.from(completed),
        installDir: config.installDir,
        startedAt: prior?.startedAt ?? new Date().toISOString(),
      });
      process.exit(1);
    }
    completed.add(step.id);
    await saveState({
      completedSteps: Array.from(completed),
      installDir: config.installDir,
      startedAt: prior?.startedAt ?? new Date().toISOString(),
    });
  }

  printSuccess(config);
}

async function runStepWithRecovery(
  step: Step,
  ctx: StepContext,
  config: InstallConfig,
): Promise<boolean> {
  // Skip if pre-check passes.
  if (step.check) {
    try {
      if (await step.check(ctx)) {
        log.ok(`${step.title} — already satisfied`);
        return true;
      }
    } catch {
      /* check itself errored — fall through to run */
    }
  }
  while (true) {
    const result = await step.run(ctx);
    if (result.ok) {
      const tail = result.skipped ? kleur.gray(" (skipped)") : "";
      log.ok((result.note ? `${step.title} — ${result.note}` : step.title) + tail);
      return true;
    }

    log.err(`${step.title} failed: ${result.error}`);
    if (result.stderr) console.log(kleur.gray(result.stderr.slice(-1500)));

    const action = await select<"retry" | "diagnose" | "skip" | "abort">({
      message: "What now?",
      options: [
        { value: "retry", label: "Retry the same step" },
        ...(config.anthropicApiKey
          ? [
              {
                value: "diagnose" as const,
                label: "Diagnose with AI",
                hint: "Claude tries to fix it",
              },
            ]
          : []),
        { value: "skip", label: "Skip and continue (advanced)" },
        { value: "abort", label: "Abort install" },
      ],
      initialValue: config.anthropicApiKey ? "diagnose" : "retry",
    });
    bail(action);

    if (action === "abort") return false;
    if (action === "skip") {
      log.warn(`Skipped: ${step.title}`);
      return true;
    }
    if (action === "retry") continue;

    if (action === "diagnose") {
      const outcome = await diagnoseAndFix({
        apiKey: config.anthropicApiKey!,
        installDir: ctx.installDir,
        failedStep: { id: step.id, title: step.title },
        error: result.error,
        stdout: result.stdout,
        stderr: result.stderr,
        installMode: config.mode,
        siteDomain: config.siteDomain,
      });
      if (outcome === "applied") continue;
    }
  }
}

function printSuccess(config: InstallConfig) {
  console.log();
  log.done("Orqestra is live.");

  console.log(kleur.bold("  URLs"));
  if (config.mode === "local") {
    console.log("    Web:        http://localhost:3000");
    console.log("    API:        http://localhost:4000");
    console.log("    WebSocket:  ws://localhost:4001");
  } else {
    console.log(`    Web:        https://${config.siteDomain}`);
    console.log(`    API:        https://api.${config.siteDomain}`);
    console.log(`    WebSocket:  wss://ws.${config.siteDomain}`);
    console.log();
    console.log(kleur.gray("    First HTTPS request triggers Let's Encrypt cert issuance via DNS-01."));
    console.log(kleur.gray("    DNS propagation + ACME usually takes 30–60 seconds."));
  }

  console.log();
  console.log(kleur.bold("  Next"));
  console.log(`    1. Open the Web URL and register the first user (becomes admin).`);
  console.log(`    2. Manage the stack:`);
  console.log(
    kleur.cyan(`         docker compose -f ${config.installDir}/docker-compose.yml ps`),
  );
  console.log(
    kleur.cyan(`         docker compose -f ${config.installDir}/docker-compose.yml logs -f`),
  );
  console.log(`    3. Re-run this installer any time — it resumes / upgrades safely.`);

  if (config.mode === "server" && config.dns === "manual") {
    console.log();
    console.log(kleur.yellow("  Reminder: wildcard DNS is on you to maintain."));
  }
  if (config.gpu === "auto") {
    console.log();
    console.log(
      kleur.gray(
        "  GPU note: containers using --gpus need an active session — re-login if `docker run --gpus all ...` errors with permission denied.",
      ),
    );
  }
  console.log();
}

main().catch((err) => {
  log.err(`Unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
