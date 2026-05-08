import { router } from "./trpc";
import { authRouter } from "./routers/auth";
import { projectsRouter } from "./routers/projects";
import { jupyterRouter } from "./routers/jupyter";
import { modelsRouter } from "./routers/models";
import { filesRouter } from "./routers/files";
import { tagsRouter } from "./routers/tags";

export const appRouter = router({
  auth: authRouter,
  projects: projectsRouter,
  jupyter: jupyterRouter,
  models: modelsRouter,
  files: filesRouter,
  tags: tagsRouter,
});

export type AppRouter = typeof appRouter;
