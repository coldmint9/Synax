const HOST_PATTERN = /^[a-z0-9.-]+(?::[0-9]+)?$/;

/**
 * Turns user input such as "https://gitlab.example.com/", "HTTP://GitLab.example.com:8443/group/app"
 * into a bare "host[:port]". Returns "" when the value cannot be a GitLab host.
 */
export function normalizeGitLabHost(value: string): string {
  const withoutScheme = value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const host = withoutScheme.split(/[/?#]/, 1)[0] ?? "";
  if (!HOST_PATTERN.test(host)) return "";
  if (host.startsWith(".") || host.endsWith(".")) return "";
  try {
    return new URL(`https://${host}`).host;
  } catch {
    return "";
  }
}
