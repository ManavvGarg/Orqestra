import {
  bigint,
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const jupyterJobType = pgEnum("jupyter_job_type", [
  "base",
  "tensorflow",
  "pytorch",
  "r",
]);

export const jupyterStatus = pgEnum("jupyter_status", [
  "creating",
  "running",
  "stopped",
  "destroyed",
  "errored",
]);

export const modelRuntime = pgEnum("model_runtime", [
  "ollama",
  "docker-model-runner",
  "llama-cpp",
]);

export const sandboxDistro = pgEnum("sandbox_distro", [
  "ubuntu-22.04",
  "ubuntu-24.04",
  "debian-12",
  "alpine-3.20",
]);

export const sandboxStatus = pgEnum("sandbox_status", [
  "creating",
  "running",
  "stopped",
  "destroyed",
  "errored",
]);

export const modelProjectStatus = pgEnum("model_project_status", [
  "pending",
  "pulling",
  "running",
  "stopped",
  "destroyed",
  "errored",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash"),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull(),
  accountId: text("account_id").notNull(),
  password: text("password"),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jupyterProjects = pgTable("jupyter_projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  jobType: jupyterJobType("job_type").notNull(),
  description: text("description"),
  containerId: text("container_id"),
  containerUrl: text("container_url"),
  containerToken: text("container_token"),
  containerPort: integer("container_port"),
  status: jupyterStatus("status").notNull().default("creating"),
  volumeName: text("volume_name").notNull(),
  cpuLimit: text("cpu_limit"),
  memoryLimit: text("memory_limit"),
  gpuIndex: integer("gpu_index"),
  vramLimitMB: integer("vram_limit_mb"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Snapshot of the model catalog (refreshed hourly). */
export const models = pgTable("models", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  parameterCount: text("parameter_count").notNull(),
  parametersRaw: bigint("parameters_raw", { mode: "number" }).notNull(),
  activeParameters: bigint("active_parameters", { mode: "number" }),
  isMoe: boolean("is_moe").notNull().default(false),
  minRamGB: doublePrecision("min_ram_gb").notNull(),
  recommendedRamGB: doublePrecision("recommended_ram_gb").notNull(),
  minVramGB: doublePrecision("min_vram_gb").notNull(),
  contextLength: integer("context_length").notNull(),
  capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
  useCase: text("use_case").notNull(),
  pipelineTag: text("pipeline_tag").notNull(),
  architecture: text("architecture").notNull(),
  hfRepo: text("hf_repo").notNull(),
  hfDownloads: integer("hf_downloads").notNull().default(0),
  hfLikes: integer("hf_likes").notNull().default(0),
  releaseDate: text("release_date"),
  /** Array of `{kind, reference, ggufFile?}`. */
  runtimes: jsonb("runtimes")
    .$type<Array<{ kind: "ollama" | "docker-model-runner" | "llama-cpp"; reference: string; ggufFile?: string }>>()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const modelProjects = pgTable("model_projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  modelId: text("model_id").references(() => models.id, { onDelete: "restrict" }),
  runtime: modelRuntime("runtime").notNull(),
  /** Resolved tag/reference at create time (e.g. "qwen2.5:7b"). */
  runtimeRef: text("runtime_ref").notNull(),
  status: modelProjectStatus("status").notNull().default("pending"),
  containerId: text("container_id"),
  containerPort: integer("container_port"),
  apiUrl: text("api_url"),
  /** Container resource limits actually applied. */
  ramLimitMB: integer("ram_limit_mb"),
  cpuLimit: doublePrecision("cpu_limit"),
  gpuIndex: integer("gpu_index"),
  /** VRAM advisory limit in MB. NVIDIA does not enforce per-container VRAM
   *  caps; this value is used by the scheduler for booking and shown in UI. */
  vramLimitMB: integer("vram_limit_mb"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sandboxProjects = pgTable("sandbox_projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  distro: sandboxDistro("distro").notNull(),
  description: text("description"),
  containerId: text("container_id"),
  containerPort: integer("container_port"),
  sshHost: text("ssh_host"),
  sshUser: text("ssh_user"),
  /** Public key baked into container `authorized_keys`. Persisted so we can
   *  show fingerprint in the UI. Private key is NOT persisted — returned once
   *  in the create response and downloaded by the user. */
  publicKey: text("public_key"),
  status: sandboxStatus("status").notNull().default("creating"),
  volumeName: text("volume_name").notNull(),
  cpuLimit: text("cpu_limit"),
  memoryLimit: text("memory_limit"),
  gpuIndex: integer("gpu_index"),
  vramLimitMB: integer("vram_limit_mb"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projectTags = pgTable(
  "project_tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#6366f1"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userNameUnique: uniqueIndex("project_tags_user_name_unique").on(table.userId, table.name),
  }),
);

export const jupyterProjectTags = pgTable(
  "jupyter_project_tags",
  {
    projectId: uuid("project_id").notNull().references(() => jupyterProjects.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id").notNull().references(() => projectTags.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.tagId] }),
  }),
);

export const sandboxProjectTags = pgTable(
  "sandbox_project_tags",
  {
    projectId: uuid("project_id").notNull().references(() => sandboxProjects.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id").notNull().references(() => projectTags.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.tagId] }),
  }),
);

export const modelProjectTags = pgTable(
  "model_project_tags",
  {
    projectId: uuid("project_id").notNull().references(() => modelProjects.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id").notNull().references(() => projectTags.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.tagId] }),
  }),
);

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  jupyterProjects: many(jupyterProjects),
  modelProjects: many(modelProjects),
  sandboxProjects: many(sandboxProjects),
  projectTags: many(projectTags),
}));

export const sandboxProjectsRelations = relations(sandboxProjects, ({ one, many }) => ({
  user: one(users, { fields: [sandboxProjects.userId], references: [users.id] }),
  tags: many(sandboxProjectTags),
}));

export const sandboxProjectTagsRelations = relations(sandboxProjectTags, ({ one }) => ({
  project: one(sandboxProjects, {
    fields: [sandboxProjectTags.projectId],
    references: [sandboxProjects.id],
  }),
  tag: one(projectTags, { fields: [sandboxProjectTags.tagId], references: [projectTags.id] }),
}));

export const jupyterProjectsRelations = relations(jupyterProjects, ({ one, many }) => ({
  user: one(users, { fields: [jupyterProjects.userId], references: [users.id] }),
  tags: many(jupyterProjectTags),
}));

export const modelProjectsRelations = relations(modelProjects, ({ one, many }) => ({
  user: one(users, { fields: [modelProjects.userId], references: [users.id] }),
  model: one(models, { fields: [modelProjects.modelId], references: [models.id] }),
  tags: many(modelProjectTags),
}));

export const projectTagsRelations = relations(projectTags, ({ one, many }) => ({
  user: one(users, { fields: [projectTags.userId], references: [users.id] }),
  jupyterProjects: many(jupyterProjectTags),
  modelProjects: many(modelProjectTags),
  sandboxProjects: many(sandboxProjectTags),
}));

export const jupyterProjectTagsRelations = relations(jupyterProjectTags, ({ one }) => ({
  project: one(jupyterProjects, {
    fields: [jupyterProjectTags.projectId],
    references: [jupyterProjects.id],
  }),
  tag: one(projectTags, { fields: [jupyterProjectTags.tagId], references: [projectTags.id] }),
}));

export const modelProjectTagsRelations = relations(modelProjectTags, ({ one }) => ({
  project: one(modelProjects, {
    fields: [modelProjectTags.projectId],
    references: [modelProjects.id],
  }),
  tag: one(projectTags, { fields: [modelProjectTags.tagId], references: [projectTags.id] }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type JupyterProject = typeof jupyterProjects.$inferSelect;
export type NewJupyterProject = typeof jupyterProjects.$inferInsert;
export type Model = typeof models.$inferSelect;
export type NewModel = typeof models.$inferInsert;
export type ModelProject = typeof modelProjects.$inferSelect;
export type NewModelProject = typeof modelProjects.$inferInsert;
export type ProjectTag = typeof projectTags.$inferSelect;
export type NewProjectTag = typeof projectTags.$inferInsert;
export type SandboxProject = typeof sandboxProjects.$inferSelect;
export type NewSandboxProject = typeof sandboxProjects.$inferInsert;
