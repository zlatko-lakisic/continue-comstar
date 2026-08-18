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
 *   AO_REACH_MTLS_DIR          (folder with cert.pem, key.pem, ca.pem)
 *   AO_REACH_LIVE_TARGETS      (optional comma-separated wss URLs)
 *
 * From continue-comstar/core:
 *   $env:AO_REACH_LIVE="1"
 *   npx jest llm/llms/AOReach.live.test.ts --testTimeout=600000
 */

import fs from "fs";
import https from "https";
import os from "os";
import path from "path";

import { ChatMessage, LLMOptions } from "../../index.js";
import AOReach from "./AOReach.js";
import { overlayRoot } from "../../test/aoReachMockEngine.js";

const LIVE = process.env.AO_REACH_LIVE === "1";
const DEFAULT_TARGETS = "wss://172.16.90.20:8765,wss://10.0.10.16:8765";

function liveTargets(): string[] {
  const raw =
    process.env.AO_REACH_LIVE_TARGETS ||
    process.env.AO_REACH_BASE_URL ||
    DEFAULT_TARGETS;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function healthUrl(wsUrl: string): string {
  return wsUrl.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
}

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

function probeHealth(
  url: string,
  mtlsDir: string,
): Promise<{ ok: boolean; detail: string }> {
  const ca = fs.readFileSync(path.join(mtlsDir, "ca.pem"));
  const cert = fs.readFileSync(path.join(mtlsDir, "cert.pem"));
  const key = fs.readFileSync(path.join(mtlsDir, "key.pem"));
  return new Promise((resolve) => {
    const req = https.request(
      `${url.replace(/\/$/, "")}/health`,
      {
        method: "GET",
        ca,
        cert,
        key,
        rejectUnauthorized: true,
        timeout: 8000,
      },
      (res) => {
        res.resume();
        resolve({
          ok: (res.statusCode || 0) < 400,
          detail: `HTTP ${res.statusCode}`,
        });
      },
    );
    req.on("error", (err) =>
      resolve({ ok: false, detail: err.message || String(err) }),
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, detail: "health probe timed out" });
    });
    req.end();
  });
}

function stockMcpLeak(frames: Record<string, unknown>[]): string | undefined {
  const blob = frames
    .map(
      (frame) =>
        `${frame.message || ""} ${frame.error || ""} ${JSON.stringify(frame.detail || "")}`,
    )
    .join(" ")
    .toLowerCase();
  for (const needle of [
    "search_tavily",
    "media_understand",
    "media_video_analyze",
  ]) {
    if (blob.includes(needle)) {
      return needle;
    }
  }
  if (
    /(^|[^a-z_.])filesystem_local([^a-z_.]|$)/.test(blob) &&
    !blob.includes("client.filesystem_local")
  ) {
    return "filesystem_local";
  }
  return undefined;
}

(LIVE ? describe : describe.skip)("AOReach live against AO", () => {
  jest.setTimeout(600_000);

  const defaultMtlsDir =
    process.env.AO_REACH_MTLS_DIR ||
    path.join(os.homedir(), ".continue-comstar", "ao-mtls");

  function mtlsDirFor(target: string): string {
    try {
      const host = new URL(
        target.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:"),
      ).hostname;
      const envName = `AO_REACH_MTLS_DIR_${host.replace(/[^A-Za-z0-9]/g, "_")}`;
      const fromEnv = process.env[envName];
      if (fromEnv && fs.existsSync(path.join(fromEnv, "ca.pem"))) {
        return fromEnv;
      }
      const sibling = path.join(
        os.homedir(),
        ".continue-comstar",
        `ao-mtls-${host}`,
      );
      if (fs.existsSync(path.join(sibling, "ca.pem"))) {
        return sibling;
      }
    } catch {
      // fall through to default
    }
    return defaultMtlsDir;
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ao-reach-live-"));
  const providers: AOReach[] = [];
  const transcripts: Record<string, unknown>[][] = [];
  const reachable = new Map<string, { ok: boolean; detail: string }>();

  beforeAll(async () => {
    if (!process.env.AO_REACH_TOKEN) {
      throw new Error(
        "AO_REACH_LIVE=1 requires AO_REACH_TOKEN in the environment.",
      );
    }
    fs.writeFileSync(path.join(workspace, "hello.txt"), "live-contract\n");
    fs.writeFileSync(
      path.join(workspace, "buggy.py"),
      "def add(a, b):\n    return a - b\n",
    );
    fs.writeFileSync(path.join(workspace, "big.txt"), "Z".repeat(9000));
    for (const target of liveTargets()) {
      const dir = mtlsDirFor(target);
      for (const name of ["cert.pem", "key.pem", "ca.pem"]) {
        if (!fs.existsSync(path.join(dir, name))) {
          reachable.set(target, {
            ok: false,
            detail: `mTLS material missing: ${path.join(dir, name)}`,
          });
          break;
        }
      }
      if (reachable.get(target)?.ok === false) {
        console.warn(
          `Skipping live target ${target}: ${reachable.get(target)?.detail}`,
        );
        continue;
      }
      const health = await probeHealth(healthUrl(target), dir);
      reachable.set(target, health);
      if (!health.ok) {
        console.warn(`Live target ${target} health failed: ${health.detail}`);
      }
    }
  });

  afterEach(() => {
    for (const provider of providers.splice(0)) {
      closeProvider(provider);
    }
  });

  function requireTarget(target: string) {
    const health = reachable.get(target);
    if (!health?.ok) {
      throw new Error(
        `Live target ${target} is unreachable (${health?.detail || "no probe"}). ` +
          "Enroll mTLS for this engine (cert/key/ca) or set AO_REACH_MTLS_DIR.",
      );
    }
  }

  function createProvider(
    baseUrl: string,
    overlay = "comstar-code-review",
    sessionSuffix = "default",
  ): AOReach {
    const provider = new AOReach({
      model: "",
      baseUrl,
      apiKey: process.env.AO_REACH_TOKEN,
      sessionOverlay: overlay,
      sessionId: `live-contract-${sessionSuffix}-${Date.now()}`,
      workspaceName: "live-contract",
      workspaceDirs: [workspace],
      overlayRoot: overlayRoot(),
      filesystemTunnel: true,
      mtlsMaterialDir: mtlsDirFor(baseUrl),
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
        transcript.push({
          type: "invalid_json",
          raw: data.toString().slice(0, 200),
        });
      }
      return original(socket, data, hooks);
    };
    return provider;
  }

  async function streamChat(
    provider: AOReach,
    content: string,
  ): Promise<{
    messages: ChatMessage[];
    transcript: Record<string, unknown>[];
  }> {
    const transcript = transcripts[transcripts.length - 1];
    try {
      const messages = (await collect(
        (provider as any)._streamChat(
          [{ role: "user", content }],
          new AbortController().signal,
          {},
        ),
      )) as ChatMessage[];
      return { messages, transcript };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${text}\n\nAO frame transcript:\n${formatTranscript(transcript)}`,
      );
    }
  }

  function assistantText(messages: ChatMessage[]): string {
    return messages
      .filter((m) => m.role === "assistant")
      .map((m) => String(m.content))
      .join("");
  }

  for (const target of liveTargets()) {
    describe(target, () => {
      it("registers the review overlay without stock MCP leak", async () => {
        requireTarget(target);
        const provider = createProvider(target, "comstar-code-review", "pong");
        const { transcript } = await streamChat(
          provider,
          "Reply with exactly the single word pong and nothing else.",
        );
        const types = transcript.map((f) => String(f.type || ""));
        expect(types[0]).toBe("hello");
        expect(types).toContain("session_overlay_ack");
        expect(types).toContain("run_end");
        const leak = stockMcpLeak(transcript);
        expect(leak).toBeUndefined();
      });

      it("reviews workspace code without empty-LLM crash or stock MCP leak", async () => {
        requireTarget(target);
        const provider = createProvider(
          target,
          "comstar-code-review",
          "review",
        );
        const { messages, transcript } = await streamChat(
          provider,
          "Review buggy.py in this workspace. Name the bug in add().",
        );
        const types = transcript.map((f) => String(f.type || ""));
        const blob = formatTranscript(transcript).toLowerCase();
        expect(blob).not.toContain("none or empty");
        expect(blob).not.toContain("fastapi");
        expect(types).toContain("run_end");
        expect(stockMcpLeak(transcript)).toBeUndefined();
        expect(assistantText(messages).length).toBeGreaterThan(0);
      });

      it("round-trips a filesystem MCP read through the session tunnel", async () => {
        requireTarget(target);
        const provider = createProvider(
          target,
          "comstar-code-review",
          "fs-hello",
        );
        const { messages, transcript } = await streamChat(
          provider,
          "Call the filesystem MCP read_file tool on hello.txt. Do not guess. Reply with only the file contents.",
        );
        const types = transcript.map((f) => String(f.type || ""));
        expect(types).toContain("run_end");
        expect(types).toContain("mcp_tunnel_request");
        expect(assistantText(messages).toLowerCase()).toContain(
          "live-contract",
        );
      });

      it("survives an oversized filesystem read without empty-LLM crash", async () => {
        requireTarget(target);
        const provider = createProvider(
          target,
          "comstar-code-review",
          "fs-big",
        );
        const { messages, transcript } = await streamChat(
          provider,
          "Call the filesystem MCP read_file tool on big.txt. Say whether the result looks truncated. Do not guess.",
        );
        const blob = formatTranscript(transcript).toLowerCase();
        expect(blob).not.toContain("none or empty");
        expect(transcript.map((f) => String(f.type || ""))).toContain(
          "run_end",
        );
        expect(assistantText(messages).length).toBeGreaterThan(0);
      });
    });
  }
});
