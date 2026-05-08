import { checkOsStep } from "./00-check-os";
import { checkDockerStep } from "./01-check-docker";
import { checkToolsStep } from "./02-check-tools";
import { cloneRepoStep } from "./03-clone-repo";
import { writeEnvStep } from "./04-write-env";
import { networkStep } from "./05-network";
import { buildImagesStep } from "./06-build-images";
import { bootInfraStep } from "./07-boot-infra";
import { dbPushStep } from "./08-db-push";
import { bootAppsStep } from "./09-boot-apps";
import { verifyStep } from "./10-verify";
import type { Step } from "../types";

export const allSteps: Step[] = [
  checkOsStep,
  checkDockerStep,
  checkToolsStep,
  cloneRepoStep,
  writeEnvStep,
  networkStep,
  buildImagesStep,
  bootInfraStep,
  dbPushStep,
  bootAppsStep,
  verifyStep,
];
