export function lastNonEmptyLine(content: string): string {
  const lines = String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] || "";
}

export function looksLikeAoProgress(content: string): boolean {
  const text = String(content || "").toLowerCase();
  if (!text.trim()) {
    return false;
  }
  return (
    text.includes("preparing ao") ||
    text.includes("preparing session") ||
    text.includes("download") ||
    text.includes("pulling") ||
    text.includes("handshake") ||
    text.includes("connecting") ||
    text.includes("warming") ||
    /\d+\s*%/.test(text)
  );
}

export function truncateStatusText(text: string, max = 80): string {
  const value = lastNonEmptyLine(text);
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function latestStreamingStatusText(
  history: Array<{ message?: { role?: string; content?: unknown } }>,
): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]?.message;
    if (message?.role !== "thinking") {
      continue;
    }
    const content = typeof message.content === "string" ? message.content : "";
    const line = truncateStatusText(content);
    if (line) {
      return line;
    }
  }
  return undefined;
}
