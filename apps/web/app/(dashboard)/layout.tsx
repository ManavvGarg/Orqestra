"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useSession, signOut } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Boxes, FileCode2, LayoutDashboard, LogOut, Tag, Terminal } from "lucide-react";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!isPending && !session) router.replace("/login");
  }, [isPending, session, router]);

  if (isPending) return <div className="p-8 text-sm text-[var(--color-muted)]">Loading…</div>;
  if (!session) return null;

  return (
    <div className="grid min-h-screen grid-cols-[16rem_1fr]">
      <aside className="border-r border-[var(--color-border)] bg-white/[0.02] p-4">
        <Link href={"/dashboard" as any} className="flex items-center gap-2 text-sm font-bold">
          <Boxes className="h-4 w-4" />
          Orqestra
        </Link>
        <nav className="mt-8 flex flex-col gap-1 text-sm">
          <NavLink href="/dashboard" icon={<LayoutDashboard className="h-4 w-4" />}>
            Overview
          </NavLink>
          <NavLink href="/jupyter/new" icon={<FileCode2 className="h-4 w-4" />}>
            New Jupyter
          </NavLink>
          <NavLink href="/models/new" icon={<Boxes className="h-4 w-4" />}>
            Host model
          </NavLink>
          <NavLink href="/sandbox/new" icon={<Terminal className="h-4 w-4" />}>
            New Sandbox
          </NavLink>
          <NavLink href="/tags" icon={<Tag className="h-4 w-4" />}>
            Tags
          </NavLink>
        </nav>
        <div className="mt-8 border-t border-[var(--color-border)] pt-4 text-xs text-[var(--color-muted)]">
          <div>{session.user.email}</div>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 w-full justify-start"
            onClick={() => signOut().then(() => router.push("/login"))}
          >
            <LogOut className="h-3 w-3" /> Sign out
          </Button>
        </div>
      </aside>
      <main className="p-8">{children}</main>
    </div>
  );
}

function NavLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href as any}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-white/5"
    >
      {icon}
      {children}
    </Link>
  );
}
