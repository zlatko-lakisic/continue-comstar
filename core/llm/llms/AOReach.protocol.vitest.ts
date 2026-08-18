/**
 * Copyright 2023-2026 Continue Dev, Inc.
 * Licensed under the Apache License, Version 2.0.
 */

import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChatMessage, LLMOptions } from "../../index.js";
import AOReach from "./AOReach.js";
import {
  overlayRoot,
  startMockAoEngine,
} from "../../test/aoReachMockEngine.js";

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

describe("AOReach engine-ws/1 protocol (mock AO)", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ao-reach-proto-"));
  const engines: Array<{ close(): Promise<void> }> = [];
  const providers: AOReach[] = [];
  const originalMtlsDir = process.env.AO_REACH_MTLS_DIR;

  beforeEach(() => {
    delete process.env.AO_REACH_MTLS_DIR;
  });

  afterEach(async () => {
    if (originalMtlsDir === undefined) {
      delete process.env.AO_REACH_MTLS_DIR;
    } else {
      process.env.AO_REACH_MTLS_DIR = originalMtlsDir;
    }
    for (const provider of providers.splice(0)) {
      closeProvider(provider);
    }
    for (const engine of engines.splice(0)) {
      await engine.close();
    }
  });

  function createProvider(
    baseUrl: string,
    overrides: Partial<LLMOptions> = {},
  ): AOReach {
    const provider = new AOReach({
      model: "",
      baseUrl,
      apiKey: "test-token",
      sessionOverlay: "comstar-code",
      workspaceName: "protocol-workspace",
      workspaceDirs: [workspace],
      overlayRoot: overlayRoot(),
      filesystemTunnel: true,
      timeoutSeconds: 5,
      ...overrides,
    } as LLMOptions);
    providers.push(provider);
    return provider;
  }

  it("streams every plugin-facing frame type into thinking then assistant text", async () => {
    const engine = await startMockAoEngine({ token: "test-token" });
    engines.push(engine);
    const provider = createProvider(engine.url);

    const messages = (await collect(
      (provider as any)._streamChat(
        [{ role: "user", content: "hi" }],
        new AbortController().signal,
        {},
      ),
    )) as ChatMessage[];

    const chat = engine.clientFrames.find((f) => f.type === "chat");
    expect(chat).toMatchObject({
      type: "chat",
      runMode: "dynamic",
      appId: "continue-comstar",
    });
    expect(
      engine.clientFrames.some((f) => f.type === "session_overlay_register"),
    ).toBe(true);
    expect(
      engine.clientFrames.some((f) => f.type === "mcp_tunnel_response"),
    ).toBe(true);

    const thinking = messages
      .filter((m) => m.role === "thinking")
      .map((m) => String(m.content));
    expect(thinking.some((t) => t.includes("Starting your request"))).toBe(
      true,
    );
    expect(
      thinking.some((t) => t.includes("Looking through the workspace")),
    ).toBe(true);
    expect(
      thinking.some((t) => t.includes("Working with code assistant")),
    ).toBe(true);
    expect(
      messages.filter((m) => m.role === "assistant").map((m) => m.content),
    ).toEqual(["pong"]);
  });

  it("surfaces the fastapi ModuleNotFoundError the way the VS Code plugin does", async () => {
    const engine = await startMockAoEngine({
      token: "test-token",
      scenario: "fastapi-error",
    });
    engines.push(engine);
    const provider = createProvider(engine.url);

    await expect(
      collect(
        (provider as any)._streamChat(
          [{ role: "user", content: "hi" }],
          new AbortController().signal,
          {},
        ),
      ),
    ).rejects.toThrow(
      /AO Reach orchestration error: No module named 'fastapi'/,
    );
  });

  it("fails overlay registration when the engine denies the pack", async () => {
    const engine = await startMockAoEngine({
      token: "test-token",
      scenario: "overlay-denied",
    });
    engines.push(engine);
    const provider = createProvider(engine.url);

    await expect(
      collect(
        (provider as any)._streamChat(
          [{ role: "user", content: "hi" }],
          new AbortController().signal,
          {},
        ),
      ),
    ).rejects.toThrow(/session overlay registration failed/);
  });

  it("yields overlay pull status as thinking and waits past a 30s wall timeout while frames arrive", async () => {
    const engine = await startMockAoEngine({
      token: "test-token",
      scenario: "overlay-pull",
    });
    engines.push(engine);
    const provider = createProvider(engine.url, { timeoutSeconds: 5 } as any);

    const messages = (await collect(
      (provider as any)._streamChat(
        [{ role: "user", content: "hi" }],
        new AbortController().signal,
        {},
      ),
    )) as ChatMessage[];

    const thinking = messages
      .filter((m) => m.role === "thinking")
      .map((m) => String(m.content))
      .join("\n");
    expect(thinking).toMatch(/Preparing AO session/);
    expect(thinking).toMatch(/Downloading qwen3\.6:27b — 40%/);
    expect(thinking).toMatch(/Downloading qwen3\.6:27b — 84%/);
    expect(
      messages.filter((m) => m.role === "assistant").map((m) => m.content),
    ).toEqual(["pong"]);
  });

  it("refuses to connect when session overlays are disabled on hello", async () => {
    const engine = await startMockAoEngine({
      token: "test-token",
      scenario: "overlay-disabled",
    });
    engines.push(engine);
    const provider = createProvider(engine.url);

    await expect((provider as any).ensureConnection()).rejects.toThrow(
      /session overlays are disabled/,
    );
  });

  it("refuses to connect when the MCP tunnel is disabled on hello", async () => {
    const engine = await startMockAoEngine({
      token: "test-token",
      scenario: "tunnel-disabled",
    });
    engines.push(engine);
    const provider = createProvider(engine.url);

    await expect((provider as any).ensureConnection()).rejects.toThrow(
      /MCP tunnel is disabled/,
    );
  });

  it("sends cancel and stops without treating cancelled as an orchestration error", async () => {
    const engine = await startMockAoEngine({
      token: "test-token",
      scenario: "hang",
    });
    engines.push(engine);
    const provider = createProvider(engine.url, { timeoutSeconds: 0 } as any);

    const controller = new AbortController();
    const gen = (provider as any)._streamChat(
      [{ role: "user", content: "hi" }],
      controller.signal,
      {},
    );
    const runner = collect(gen);
    const chat = await engine.waitForClient("chat", 5000);
    expect(chat.type).toBe("chat");
    expect(engine.clientFrames.some((f) => f.type === "chat")).toBe(true);
    // Let _streamChat attach the abort listener and park on nextFrame.
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await engine.waitForClient("cancel", 2000);
    await expect(runner).resolves.toBeDefined();
  });
});
