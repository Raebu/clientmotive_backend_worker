export function id(prefix: string): string {
  return prefix + "_" + crypto.randomUUID().replaceAll("-", "");
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : "https://" + trimmed);
    return url.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

export function safeUrl(input: string | null | undefined): string | null {
  const domain = normalizeDomain(input);
  return domain ? "https://" + domain + "/" : null;
}
