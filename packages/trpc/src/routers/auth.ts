import { router, publicProcedure, protectedProcedure } from "../trpc";

export const authRouter = router({
  me: publicProcedure.query(({ ctx }) => {
    if (!ctx.user) return null;
    return {
      id: ctx.user.id,
      email: ctx.user.email,
      name: ctx.user.name,
      image: ctx.user.image,
    };
  }),

  session: protectedProcedure.query(({ ctx }) => ({
    user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name },
    sessionId: ctx.sessionId,
  })),
});
