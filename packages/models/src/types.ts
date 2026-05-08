import { z } from "zod";

export const runtimeKindSchema = z.enum(["ollama", "docker-model-runner", "llama-cpp"]);
export type RuntimeKind = z.infer<typeof runtimeKindSchema>;

export const runtimeOptionSchema = z.object({
  kind: runtimeKindSchema,
  /** Ollama tag, DMR tag (`ai/<repo>:<size>`), or HF GGUF repo. */
  reference: z.string(),
  /** Hint for which file inside the GGUF repo to use, if applicable. */
  ggufFile: z.string().optional(),
});
export type RuntimeOption = z.infer<typeof runtimeOptionSchema>;

export const catalogModelSchema = z.object({
  /** Stable id, lowercased HF repo. */
  id: z.string(),
  /** Pretty display name. */
  name: z.string(),
  provider: z.string(),
  parameterCount: z.string(),
  parametersRaw: z.number().int().positive(),
  /** Active params for MoE; equals total for dense. */
  activeParameters: z.number().int().positive().nullable(),
  isMoe: z.boolean(),
  minRamGB: z.number().nonnegative(),
  recommendedRamGB: z.number().nonnegative(),
  minVramGB: z.number().nonnegative(),
  contextLength: z.number().int().positive(),
  capabilities: z.array(z.string()),
  useCase: z.string(),
  pipelineTag: z.string(),
  architecture: z.string(),
  hfRepo: z.string(),
  hfDownloads: z.number().int().nonnegative().default(0),
  hfLikes: z.number().int().nonnegative().default(0),
  releaseDate: z.string().nullable().optional(),
  runtimes: z.array(runtimeOptionSchema).min(1),
  /** Iso timestamp of last refresh that touched this entry. */
  updatedAt: z.string(),
});
export type CatalogModel = z.infer<typeof catalogModelSchema>;

export const catalogSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  models: z.array(catalogModelSchema),
});
export type Catalog = z.infer<typeof catalogSchema>;
