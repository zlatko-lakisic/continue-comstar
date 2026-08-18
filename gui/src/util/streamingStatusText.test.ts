import { describe, expect, it } from "vitest";

import {
  lastNonEmptyLine,
  latestStreamingStatusText,
  looksLikeAoProgress,
  mergeThinkingContent,
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
});
