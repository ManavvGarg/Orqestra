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

  const ctx: StepContext = {
    config,
    installDir: config.installDir,
    state: {},
  };

  const prior = await loadState(config.installDir);
  const completed = new Set(prior?.completedSteps ?? []);
  if (prior && completed.size > 0) {
    const resume = await confirm({
      message: `Found ${completed.size} previously-completed steps. Resume from where it left off?`,
      initialValue: true,
    });
    bail(resume);
    if (!resume) completed.clear();
  }

  const total = allSteps.length;
  let i = 0;
  for (const step of allSteps) {
    i++;
    if (completed.has(step.id)) {
      log.step(i, total, kleur.gray(`${step.title} (skipped — already done)`));
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
  while (true) {
    const result = await step.run(ctx);
    if (result.ok) {
      log.ok(result.note ? `${step.title} — ${result.note}` : step.title);
      return true;
    }

    log.err(`${step.title} failed: ${result.error}`);
    if (result.stderr) console.log(kleur.gray(result.stderr.slice(-1500)));

    const action = await select<"retry" | "diagnose" | "skip" | "abort">({
      message: "What now?",
      options: [
        { value: "retry", label: "Retry the same step" },
        ...(config.anthropicApiKey
          ? [{ value: "diagnose" as const, label: "Diagnose with AI", hint: "needs ANTHROPIC_API_KEY" }]
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
  log.done("Orqestra is up.");
  if (config.mode === "local") {
    console.log("  Web:  http://localhost:3000");
    console.log("  API:  http://localhost:4000");
    console.log("  WS:   ws://localhost:4001");
  } else {
    console.log(`  Web:  https://${config.siteDomain}`);
    console.log(`  API:  https://api.${config.siteDomain}`);
    console.log(`  WS:   wss://ws.${config.siteDomain}`);
    console.log();
    console.log("  TLS will issue on first request — first hits may be slow while the cert is provisioned.");
  }
  console.log();
  console.log("  Manage with:  docker compose -f " + config.installDir + "/docker-compose.yml [logs|ps|down]");
  console.log();
}

main().catch((err) => {
  log.err(`Unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
