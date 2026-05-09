import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@orqestra/trpc";

export const trpc: ReturnType<typeof createTRPCReact<AppRouter>> =
  createTRPCReact<AppRouter>();