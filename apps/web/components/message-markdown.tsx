"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { cn } from "@/lib/utils";

/**
 * Renders an agent/user message as markdown: GFM (tables, lists, fenced code,
 * strikethrough) + LaTeX math ($…$, \(…\), \[…\]) via KaTeX. Styling is done
 * with explicit element overrides since the project doesn't ship a prose
 * plugin. Safe by default — react-markdown does not render raw HTML.
 */
export function MessageMarkdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn("text-sm leading-relaxed", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          h1: ({ children }) => <h1 className="mb-2 mt-3 text-base font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-3 text-sm font-semibold">{children}</h2>,
          h3: ({ children }) => (
            <h3 className="mb-1 mt-2 text-sm font-semibold text-[var(--color-muted)]">{children}</h3>
          ),
          ul: ({ children }) => <ul className="my-2 ml-5 list-disc space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 ml-5 list-decimal space-y-1">{children}</ol>,
          li: ({ children }) => <li className="pl-1">{children}</li>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--color-info)] underline"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-[var(--color-border)] pl-3 text-[var(--color-muted)]">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-[var(--color-border)]" />,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-[var(--color-border)] bg-white/5 px-2 py-1 text-left font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-[var(--color-border)] px-2 py-1">{children}</td>
          ),
          code: ({ className: cls, children }) => {
            // Fenced blocks get a language- class; inline code does not.
            const isBlock = /language-/.test(cls ?? "");
            if (isBlock) {
              return (
                <code className={cn("font-mono text-xs", cls)}>{children}</code>
              );
            }
            return (
              <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[0.85em]">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-md border border-[var(--color-border)] bg-black/40 p-3 text-xs">
              {children}
            </pre>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
