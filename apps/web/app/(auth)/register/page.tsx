"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { signUp } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    const res = await signUp.email({ email, password, name });
    setLoading(false);
    if (res.error) {
      setErr(res.error.message ?? "Sign up failed");
      return;
    }
    router.push("/dashboard");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-8">
      <h1 className="mb-1 text-2xl font-semibold">Create account</h1>
      <p className="mb-6 text-sm text-[var(--color-muted)]">Start orchestrating in 30 seconds.</p>
      <form className="flex flex-col gap-3" onSubmit={onSubmit}>
        <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <Input
          placeholder="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Input
          placeholder="Password (min 8 chars)"
          type="password"
          autoComplete="new-password"
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {err ? <div className="text-sm text-[var(--color-error)]">{err}</div> : null}
        <Button type="submit" disabled={loading}>
          {loading ? "Creating…" : "Create account"}
        </Button>
      </form>
      <p className="mt-4 text-sm text-[var(--color-muted)]">
        Already have one?{" "}
        <Link href={"/login" as any} className="underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
