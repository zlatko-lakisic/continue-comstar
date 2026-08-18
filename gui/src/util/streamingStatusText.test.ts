import { describe, expect, it } from "vitest";

import {
  lastNonEmptyLine,
  latestStreamingStatusText,
  looksLikeAoProgress,
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
});
