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
    console.log();
    console.log(kleur.bold().cyan("  ▲ Orqestra installer"));
    console.log(kleur.gray("    Container orchestration, self-hosted."));
    console.log();
  },
  done: (msg: string) => console.log(kleur.green().bold("\n  ✓ ") + msg + "\n"),
};
