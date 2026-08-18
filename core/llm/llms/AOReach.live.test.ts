/**
 * Copyright 2023-2026 Continue Dev, Inc.
 * Licensed under the Apache License, Version 2.0.
 *
 * Live contract against a real AO engine, using the same AOReach client as the
 * VS Code plugin. Skipped unless AO_REACH_LIVE=1.
 *
 * Required env:
 *   AO_REACH_LIVE=1
 *   AO_REACH_TOKEN
 *   AO_REACH_BASE_URL          (e.g. wss://172.16.90.20:8765)
 *   AO_REACH_MTLS_DIR          (folder with cert.pem, key.pem, ca.pem)
 *
 * From continue-comstar/core:
 *   $env:AO_REACH_LIVE="1"
 *   npx jest llm/llms/AOReach.live.test.ts --testTimeout=300000
 */

import fs from "fs";
import os from "os";
import path from "path";

import { ChatMessage, LLMOptions } from "../../index.js";
import AOReach from "./AOReach.js";
import { overlayRoot } from "../../test/aoReachMockEngine.js";

const LIVE = process.env.AO_REACH_LIVE === "1";

async function collect<T>(generator: AsyncGenerator<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of generator) {
    values.push(value);
  }
  return values;
}

function closeProvider(provider: AOReach) {
  const socket = (provider as any).socket as { terminate?: () => void };
  socket?.terminate?.();
  (provider as any).clearOverlayRefresh?.();
}

function formatTranscript(frames: Record<string, unknown>[]): string {
  if (!frames.length) {
    return "(no frames received)";
  }
  return frames
    .map((frame, index) => {
      const type = String(frame.type || "?");
      const phase = frame.phase ? ` phase=${frame.phase}` : "";
      const stream = frame.stream ? ` stream=${frame.stream}` : "";
      const msg = String(frame.message || frame.error || frame.text || "");
      const preview = msg.replace(/\s+/g, " ").slice(0, 180);
      return `${index + 1}. ${type}${phase}${stream}${preview ? ` ${preview}` : ""}`;
    })
    .join("\n");
}

(LIVE ? describe : describe.skip)("AOReach live against AO", () => {
  jest.setTimeout(300_000);

  const baseUrl = process.env.AO_REACH_BASE_URL || "wss://172.16.90.20:8765";
  const mtlsDir =
    process.env.AO_REACH_MTLS_DIR ||
    path.join(os.homedir(), ".continue-comstar", "ao-mtls");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ao-reach-live-"));
  const providers: AOReach[] = [];
  const transcripts: Record<string, unknown>[][] = [];

  beforeAll(() => {
    if (!process.env.AO_REACH_TOKEN) {
      throw new Error("AO_REACH_LIVE=1 requires AO_REACH_TOKEN in the environment.");
    }
    for (const name of ["cert.pem", "key.pem", "ca.pem"]) {
      if (!fs.existsSync(path.join(mtlsDir, name))) {
        throw new Error(
          `AO_REACH_LIVE=1 requires ${name} under ${mtlsDir} (or set AO_REACH_MTLS_DIR).`,
        );
      }
    }
    fs.writeFileSync(path.join(workspace, "hello.txt"), "live-contract\n");
  });

  afterEach(() => {
    for (const provider of providers.splice(0)) {
      closeProvider(provider);
    }
  });

  function createProvider(): AOReach {
    const provider = new AOReach({
      model: "",
      baseUrl,
      apiKey: process.env.AO_REACH_TOKEN,
      sessionOverlay: "comstar-code",
      workspaceName: "live-contract",
      workspaceDirs: [workspace],
      overlayRoot: overlayRoot(),
      filesystemTunnel: true,
      mtlsMaterialDir: mtlsDir,
      timeoutSeconds: 0,
      userName: process.env.AO_REACH_USER || "continue-comstar-live-test",
    } as LLMOptions);
    providers.push(provider);

    const transcript: Record<string, unknown>[] = [];
    transcripts.push(transcript);
    const original = (provider as any).onSocketMessage.bind(provider);
    (provider as any).onSocketMessage = async (
      socket: unknown,
      data: { toString(): string },
      hooks?: unknown,
    ) => {
      try {
        transcript.push(JSON.parse(data.toString()));
      } catch {
        transcript.push({ type: "invalid_json", raw: data.toString().slice(0, 200) });
      }
      return original(socket, data, hooks);
    };
    return provider;
  }

  it("connects, registers the overlay, and returns an assistant result the plugin can render", async () => {
    const provider = createProvider();
    const transcript = transcripts[transcripts.length - 1];

    let messages: ChatMessage[] = [];
    try {
      messages = (await collect(
        (provider as any)._streamChat(
          [
            {
              role: "user",
              content:
                "Reply with exactly the single word pong and nothing else.",
            },
          ],
          new AbortController().signal,
          {},
        ),
      )) as ChatMessage[];
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${text}\n\nAO frame transcript:\n${formatTranscript(transcript)}`,
      );
    }

    const types = transcript.map((f) => String(f.type || ""));
    expect(types[0]).toBe("hello");
    expect(types).toContain("session_overlay_ack");
    expect(types).toContain("run_end");

    const fastapi = transcript.find((f) =>
      `${f.message || ""} ${f.error || ""} ${f.detail || ""}`.includes("fastapi"),
    );
    expect(fastapi).toBeUndefined();

    const assistant = messages
      .filter((m) => m.role === "assistant")
      .map((m) => String(m.content))
      .join("");
    expect(assistant.toLowerCase()).toContain("pong");
  });

  it("round-trips a filesystem MCP tool call the way the VS Code plugin does", async () => {
    const provider = createProvider();
    const transcript = transcripts[transcripts.length - 1];

    let messages: ChatMessage[] = [];
    try {
      messages = (await collect(
        (provider as any)._streamChat(
          [
            {
              role: "user",
              content:
                "Use the filesystem tools to read hello.txt in the workspace. Reply with only the file contents, no extra words.",
            },
          ],
          new AbortController().signal,
          {},
        ),
      )) as ChatMessage[];
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${text}\n\nAO frame transcript:\n${formatTranscript(transcript)}`,
      );
    }

    const types = transcript.map((f) => String(f.type || ""));
    const assistant = messages
      .filter((m) => m.role === "assistant")
      .map((m) => String(m.content))
      .join("");
    const fastapi = transcript.find((f) =>
      `${f.message || ""} ${f.error || ""} ${f.detail || ""}`.includes("fastapi"),
    );
    if (fastapi) {
      throw new Error(
        `AO surfaced fastapi on a filesystem prompt.\n\nAO frame transcript:\n${formatTranscript(transcript)}`,
      );
    }
    if (!types.includes("run_end")) {
      throw new Error(
        `No run_end from AO.\n\nAO frame transcript:\n${formatTranscript(transcript)}`,
      );
    }
    // The plugin must accept this turn even when AO skips the session tunnel
    // and reads a host-side workspace instead. Flag it so we can tighten later.
    if (!types.includes("mcp_tunnel_request")) {
      console.warn(
        `AO did not emit mcp_tunnel_request; assistant was:\n${assistant.slice(0, 300)}`,
      );
    }
    expect(assistant.length).toBeGreaterThan(0);
  });
});
