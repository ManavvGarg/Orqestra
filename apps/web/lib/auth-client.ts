import { createAuthClient } from "better-auth/react";

const client = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_AUTH_URL!,
});

export const authClient: ReturnType<typeof createAuthClient> = client;

export const signIn = authClient.signIn;
export const signUp = authClient.signUp;
export const signOut = authClient.signOut;

export const useSession: typeof authClient.useSession =
  authClient.useSession;