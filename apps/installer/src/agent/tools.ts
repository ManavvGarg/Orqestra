import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { sh, exec } from "../lib/shell";
import { confirm, text, bail } from "../ui/prompts";

export interface ProposedFix {
  diagnosis: string;
  commands: string[];
  explanation: string;
  destructive: boolean;
}

export interface AgentRunState {
  installDir: string;
  proposedFix: ProposedFix | null;
}

export function buildTools(state: AgentRunState) {
  const runCommand = betaZodTool({
    name: "run_command",
    description:
      "Run a shell command on the host. Returns stdout, stderr, and exit code. Truncated to 4000 chars per stream. Default timeout 60s.",
    inputSchema: z.object({
      command: z.string().describe("Shell command to run, executed via /bin/sh -c."),
      cwd: z
        .string()
        .optional()
        .describe("Working directory. Defaults to the install directory."),
      timeoutSeconds: z.number().int().positive().max(300).optional(),
    }),
    run: async ({ command, cwd, timeoutSeconds }) => {
      const r = await sh(command, {
        cwd: cwd ?? state.installDir,
        timeoutMs: (timeoutSeconds ?? 60) * 1000,
      });
      const trim = (s: string) => (s.length > 4000 ? s.slice(0, 4000) + "\n…[truncated]" : s);
      return JSON.stringify({
        exitCode: r.exitCode,
        stdout: trim(r.stdout),
        stderr: trim(r.stderr),
      });
    },
  });

  const readFileTool = betaZodTool({
    name: "read_file",
    description:
      "Read a file. Returns up to 200 lines from a given offset. Use for config files (.env, docker-compose.yml, package.json).",
    inputSchema: z.object({
      path: z.string().describe("Absolute or installDir-relative path."),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(500).optional(),
    }),
    run: async ({ path, offset = 0, limit = 200 }) => {
      const abs = path.startsWith("/") ? path : `${state.installDir}/${path}`;
      if (!existsSync(abs)) return JSON.stringify({ error: "file not found", path: abs });
      try {
        const content = await readFile(abs, "utf-8");
        const lines = content.split("\n");
        const slice = lines.slice(offset, offset + limit).join("\n");
        return JSON.stringify({
          path: abs,
          totalLines: lines.length,
          startedAt: offset,
          content: slice,
        });
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
    },
  });

  const grepTool = betaZodTool({
    name: "grep",
    description:
      "Run grep -rni against a path with a regex. Returns the first 80 matches. Use for log searches, finding config keys.",
    inputSchema: z.object({
      pattern: z.string(),
      path: z.string(),
      ignoreCase: z.boolean().optional(),
    }),
    run: async ({ pattern, path, ignoreCase = true }) => {
      const abs = path.startsWith("/") ? path : `${state.installDir}/${path}`;
      const flags = ignoreCase ? "-rni" : "-rn";
      const r = await exec(["grep", flags, pattern, abs], { timeoutMs: 30_000 });
      const lines = r.stdout.split("\n").slice(0, 80).join("\n");
      return JSON.stringify({
        matches: lines || "(no matches)",
        exitCode: r.exitCode,
      });
    },
  });

  const askUserTool = betaZodTool({
    name: "ask_user",
    description:
      "Pause and ask the user a question — only when the answer materially changes the fix. Returns the user's reply as a string. Avoid for things you can determine yourself.",
    inputSchema: z.object({
      question: z.string(),
      kind: z.enum(["text", "confirm"]).optional(),
    }),
    run: async ({ question, kind = "text" }) => {
      if (kind === "confirm") {
        const v = await confirm({ message: question, initialValue: false });
        bail(v);
        return JSON.stringify({ answer: v ? "yes" : "no" });
      }
      const v = await text({ message: question });
      bail(v);
      return JSON.stringify({ answer: String(v) });
    },
  });

  const proposeFixTool = betaZodTool({
    name: "propose_fix",
    description:
      "Submit your diagnosis and the commands the user should run. Calling this ENDS the diagnostic loop. List commands in order. If you cannot diagnose, pass an empty array and explain in the explanation.",
    inputSchema: z.object({
      diagnosis: z.string().describe("One-line statement of the root cause."),
      commands: z
        .array(z.string())
        .describe("Shell commands the user should run, in order. Empty if no fix found."),
      explanation: z
        .string()
        .describe("Why these commands fix it, in 2-4 sentences. No fluff."),
      destructive: z
        .boolean()
        .describe("True if any command modifies/deletes data outside the Orqestra install dir."),
    }),
    run: async (fix) => {
      state.proposedFix = fix;
      return JSON.stringify({ accepted: true });
    },
  });

  return [runCommand, readFileTool, grepTool, askUserTool, proposeFixTool];
}
