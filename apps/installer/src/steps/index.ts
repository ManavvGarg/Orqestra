import { checkOsStep } from "./00-check-os";
import { preflightStep } from "./00-preflight";
import { checkToolsStep } from "./02-check-tools";
import { installDockerStep } from "./01-install-docker";
import { installNvidiaStep } from "./02-install-nvidia";
import { firewallStep } from "./03-firewall";
import { cloneRepoStep } from "./03-clone-repo";
import { writeEnvStep } from "./04-write-env";
import { networkStep } from "./05-network";
import { cloudflareDnsStep, dnsManualGuideStep } from "./04-dns";
import { buildImagesStep } from "./06-build-images";
import { bootInfraStep } from "./07-boot-infra";
import { dbPushStep } from "./08-db-push";
import { bootAppsStep } from "./09-boot-apps";
import { verifyStep } from "./10-verify";
import type { Step } from "../types";

/**
 * Order matters — phases:
 *   1. Sanity checks       (os, tools)
 *   2. System setup        (docker, nvidia, firewall)
 *   3. Source              (clone, env, network)
 *   4. DNS                 (server-only)
 *   5. Build + boot        (images, infra, db, apps)
 *   6. Verify
 *
 * Steps with `appliesTo` are filtered against the live config at runtime, so
 * server-only / GPU-only / DNS-mode-specific steps drop out for local installs.
 */
export const allSteps: Step[] = [
  checkOsStep,
  preflightStep,
  checkToolsStep,
  installDockerStep,
  installNvidiaStep,
  firewallStep,
  cloneRepoStep,
  writeEnvStep,
  networkStep,
  cloudflareDnsStep,
  dnsManualGuideStep,
  buildImagesStep,
  bootInfraStep,
  dbPushStep,
  bootAppsStep,
  verifyStep,
];
