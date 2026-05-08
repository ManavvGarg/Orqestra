import kleur from "kleur";

export const log = {
  info: (msg: string) => console.log(kleur.cyan("ℹ"), msg),
  ok: (msg: string) => console.log(kleur.green("✓"), msg),
  warn: (msg: string) => console.log(kleur.yellow("⚠"), msg),
  err: (msg: string) => console.log(kleur.red("✗"), msg),
  step: (n: number, total: number, title: string) =>
    console.log(kleur.gray(`[${n}/${total}]`), kleur.bold(title)),
  raw: (msg: string) => console.log(msg),
  banner: () => {
    const lines = [
      "",
      kleur.bold().cyan("  ▲ Orqestra installer"),
      kleur.gray("    Self-hosted container orchestration for notebooks + LLMs."),
      "",
      kleur.gray("    What this does:"),
      kleur.gray("      • Pulls the source, writes a validated .env"),
      kleur.gray("      • Boots Postgres + Redis + Traefik (server) or just Postgres + Redis (local)"),
      kleur.gray("      • Builds + starts api / ws / web / orchestrators"),
      kleur.gray("      • Verifies health"),
      "",
      kleur.gray("    You can re-run this any time — it resumes from the last good step."),
      "",
    ];
    for (const l of lines) console.log(l);
  },
  section: (label: string) => {
    console.log();
    console.log(kleur.bold().underline(label));
    console.log();
  },
  done: (msg: string) => console.log(kleur.green().bold("\n  ✓ ") + msg + "\n"),
};
