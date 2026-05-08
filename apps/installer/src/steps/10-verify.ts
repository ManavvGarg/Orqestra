import { sh } from "../lib/shell";
import type { Step } from "../types";

export const verifyStep: Step = {
  id: "verify",
  title: "Verify health endpoints",
  async run({ installDir, config }) {
    const targets =
      config.mode === "local"
        ? [
            { name: "api", url: "http://localhost:4000/health" },
            { name: "ws", url: "http://localhost:4001/health" },
            { name: "web", url: "http://localhost:3000" },
          ]
        : [
            { name: "api", url: `https://api.${config.siteDomain}/health` },
            { name: "ws", url: `https://ws.${config.siteDomain}/health` },
            { name: "web", url: `https://${config.siteDomain}` },
          ];

    const failed: string[] = [];
    for (const t of targets) {
      let ok = false;
      for (let i = 0; i < 30; i++) {
        const r = await sh(`curl -fsSL --max-time 5 -o /dev/null "${t.url}"`);
        if (r.ok) {
          ok = true;
          break;
        }
        await new Promise((res) => setTimeout(res, 2000));
      }
      if (!ok) failed.push(t.name);
    }

    if (failed.length > 0) {
      const logs = await sh(
        `docker compose logs --tail=80 ${failed.join(" ")}`,
        { cwd: installDir },
      );
      return {
        ok: false,
        error: `Services unhealthy: ${failed.join(", ")}`,
        stdout: logs.stdout,
        stderr: logs.stderr,
      };
    }
    return { ok: true };
  },
};
