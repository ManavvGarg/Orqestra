import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Landing() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-start justify-center gap-6 p-8">
      <span className="text-xs uppercase tracking-widest text-[var(--color-muted)]">Orqestra</span>
      <h1 className="text-4xl font-bold leading-tight">
        Spin up Jupyter notebooks and ship static sites — from one dashboard.
      </h1>
      <p className="max-w-prose text-[var(--color-muted)]">
        Isolated Docker containers, persistent volumes, real-time logs, automatic SSL.
        Deploy from a GitHub URL or boot a TensorFlow notebook in seconds.
      </p>
      <div className="flex gap-2">
        <Button asChild>
          <Link href={"/register" as any}>Get started</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href={"/login" as any}>Sign in</Link>
        </Button>
      </div>
    </main>
  );
}
