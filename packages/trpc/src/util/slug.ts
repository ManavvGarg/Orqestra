const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function randomSuffix(length = 6): string {
  let out = "";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i++) {
    out += SLUG_ALPHABET[bytes[i]! % SLUG_ALPHABET.length];
  }
  return out;
}

export function buildSlug(name: string): string {
  const base = slugify(name) || "project";
  return `${base}-${randomSuffix()}`;
}
