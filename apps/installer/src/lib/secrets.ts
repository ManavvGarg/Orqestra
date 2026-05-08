import { sh } from "./shell";

export async function randomHex(bytes = 32): Promise<string> {
  const r = await sh(`openssl rand -hex ${bytes}`);
  if (r.ok) return r.stdout.trim();

  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
