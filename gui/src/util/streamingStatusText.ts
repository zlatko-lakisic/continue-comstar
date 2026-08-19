export function lastNonEmptyLine(content: string): string {
  const lines = thinkingLogLines(content);
  return lines[lines.length - 1] || "";
}

/** Strip elapsed / percent so heartbeat updates compare as the same status line. */
export function progressLineKey(line: string): string {
  return String(line || "")
    .trim()
    .replace(/\(\s*(?:\d+\s*m(?:in)?s?\s*)?\d+\s*s(?:ec)?s?\s*\)/gi, "")
    .replace(/\d+\s*%/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Model name shared by Consulting / Still working with progress lines. */
function llmConsultModelKey(line: string): string | undefined {
  const key = progressLineKey(line);
  const consulting = key.match(/^consulting\s+(.+?)(?:…|\.\.\.)?\s*$/);
  if (consulting) {
    return consulting[1].trim();
  }
  const continuing = key.match(/^still working with\s+(.+?)(?:…|\.\.\.)?\s*$/);
  if (continuing) {
    return continuing[1].trim();
  }
  return undefined;
}

export function sameProgressFamily(a: string, b: string): boolean {
  const left = progressLineKey(a);
  const right = progressLineKey(b);
  if (Boolean(left) && left === right) {
    return true;
  }
  const leftModel = llmConsultModelKey(a);
  const rightModel = llmConsultModelKey(b);
  return Boolean(leftModel) && leftModel === rightModel;
}

/** Drop debug junk and normalize agent reasoning lines for the AO thinking log. */
export function sanitizeThinkingLine(line: string): string | null {
  const trimmed = String(line || "").trim();
  if (!trimmed) {
    return null;
  }
  if (/Model input\s*\(/i.test(trimmed)) {
    return null;
  }
  if (/<important_rules>/i.test(trimmed)) {
    return null;
  }
  if (/Current Task:\s*<system>/i.test(trimmed)) {
    return null;
  }
  const thoughtMatch = trimmed.match(/^\(agent\)\s*Thought:\s*(.+)$/i);
  if (thoughtMatch) {
    return `Thought: ${thoughtMatch[1].trim()}`;
  }
  const actionMatch = trimmed.match(/^\(agent\)\s*Action:\s*(.+)$/i);
  if (actionMatch) {
    return `Action: ${actionMatch[1].trim()}`;
  }
  return trimmed;
}

export function thinkingLogLines(content: string): string[] {
  const raw = String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lines: string[] = [];
  for (const line of raw) {
    const prev = lines[lines.length - 1];
    if (prev && (prev === line || sameProgressFamily(prev, line))) {
      lines[lines.length - 1] = line;
      continue;
    }
    lines.push(line);
  }
  return lines;
}

export function mergeThinkingContent(
  existing: string,
  incoming: string,
): string {
  const incomingText = String(incoming || "");
  const existingText = String(existing || "");
  if (!incomingText) {
    return existingText;
  }
  const existingLine = lastNonEmptyLine(existingText);
  const incomingLine = lastNonEmptyLine(incomingText);
  if (
    existingLine &&
    incomingLine &&
    sameProgressFamily(existingLine, incomingLine)
  ) {
    const merged = thinkingLogLines(`${existingText}\n${incomingText}`);
    return merged.length ? `${merged.join("\n")}\n` : "";
  }
  return existingText + incomingText;
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
    text.includes("working through") ||
    text.includes("consulting") ||
    text.includes("still working with") ||
    text.includes("running:") ||
    text.includes("reading:") ||
    text.includes("updating:") ||
    text.startsWith("thought:") ||
    text.startsWith("action:") ||
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
