const GITHUB_RE =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/;

export function isValidGithubUrl(url: string): boolean {
  return GITHUB_RE.test(url.trim());
}
