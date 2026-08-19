import { describe, expect, it } from "vitest";

import {
  lastNonEmptyLine,
  latestStreamingStatusText,
  looksLikeAoProgress,
  mergeThinkingContent,
  sameProgressFamily,
  sanitizeThinkingLine,
  thinkingLogLines,
  truncateStatusText,
} from "./streamingStatusText";

describe("streamingStatusText", () => {
  it("uses the last thinking line for the Generating toolbar", () => {
    expect(
      lastNonEmptyLine(
        "Preparing AO session…\nDownloading qwen3.6:27b — 84%\n",
      ),
    ).toBe("Downloading qwen3.6:27b — 84%");
    expect(
      latestStreamingStatusText([
        { message: { role: "user", content: "hi" } },
        {
          message: {
            role: "thinking",
            content: "Preparing AO session…\nDownloading qwen3.6:27b — 84%\n",
          },
        },
      ]),
    ).toBe("Downloading qwen3.6:27b — 84%");
  });

  it("detects AO operational progress vs ordinary CoT", () => {
    expect(looksLikeAoProgress("Downloading qwen3.6:27b — 84%")).toBe(true);
    expect(looksLikeAoProgress("Preparing AO session…")).toBe(true);
    expect(looksLikeAoProgress("I should inspect the test file first.")).toBe(
      false,
    );
  });

  it("truncates long status lines", () => {
    expect(truncateStatusText("x".repeat(90), 80).length).toBe(80);
  });

  it("collapses consecutive heartbeat and percent lines into the latest", () => {
    expect(
      thinkingLogLines(
        [
          "Preparing AO session…",
          "Working through 1 step…",
          "Working through 1 step… (10s)",
          "Working through 1 step… (1m 40s)",
          "Working through 1 step… (1m 40s)",
        ].join("\n"),
      ),
    ).toEqual(["Preparing AO session…", "Working through 1 step… (1m 40s)"]);
    expect(
      thinkingLogLines(
        "Downloading qwen3.6:27b — 40%\nDownloading qwen3.6:27b — 84%\n",
      ),
    ).toEqual(["Downloading qwen3.6:27b — 84%"]);
  });

  it("merges a new heartbeat into the last thinking line", () => {
    expect(
      mergeThinkingContent(
        "Preparing AO session…\nWorking through 1 step… (10s)\n",
        "Working through 1 step… (20s)\n",
      ),
    ).toBe("Preparing AO session…\nWorking through 1 step… (20s)\n");
  });

  it("concatenates ordinary thinking tokens instead of splitting them", () => {
    expect(mergeThinkingContent("I think we", " should inspect")).toBe(
      "I think we should inspect",
    );
  });

  it("drops Model input and system-prompt junk from thinking lines", () => {
    expect(
      sanitizeThinkingLine(
        "Model input (qwen3.6:27b): Current Task: <system>…",
      ),
    ).toBeNull();
    expect(
      sanitizeThinkingLine("Current Task: <system>You are a helper</system>"),
    ).toBeNull();
    expect(
      sanitizeThinkingLine(
        "Follow <important_rules> and obey tools</important_rules>",
      ),
    ).toBeNull();
    expect(sanitizeThinkingLine("Checking git status…")).toBe(
      "Checking git status…",
    );
  });

  it("maps agent Thought and Action prefixes to cleaner labels", () => {
    expect(
      sanitizeThinkingLine("(agent) Thought: re-staging package.json"),
    ).toBe("Thought: re-staging package.json");
    expect(sanitizeThinkingLine("(agent) Action: git add package.json")).toBe(
      "Action: git add package.json",
    );
  });

  it("treats Consulting and Still working with as one progress family", () => {
    expect(
      sameProgressFamily(
        "Consulting qwen3.6:27b…",
        "Still working with qwen3.6:27b…",
      ),
    ).toBe(true);
    expect(
      sameProgressFamily(
        "Consulting qwen3.6:27b… (2m 00s)",
        "Still working with qwen3.6:27b… (2m 10s)",
      ),
    ).toBe(true);
    expect(
      thinkingLogLines(
        [
          "Consulting qwen3.6:27b…",
          "Still working with qwen3.6:27b… (1m 40s)",
        ].join("\n"),
      ),
    ).toEqual(["Still working with qwen3.6:27b… (1m 40s)"]);
  });
});
