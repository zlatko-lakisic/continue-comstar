/**
 * Copyright 2023-2026 Continue Dev, Inc.
 * Licensed under the Apache License, Version 2.0.
 */

import WebSocket from "ws";

import { ChatMessage, LLMOptions } from "../../index.js";
import AOReach from "./AOReach.js";

function createProvider(overrides: Partial<LLMOptions> = {}): AOReach {
  return new AOReach({
    model: "",
    baseUrl: "ws://ao.test",
    apiKey: "test-token",
    sessionOverlay: "comstar-code",
    workspaceName: "sample-workspace",
    ...overrides,
  });
}

function attachSocket(
  provider: AOReach,
  onSend: (frame: Record<string, unknown>) => void,
) {
  const socket = {
    readyState: WebSocket.OPEN,
    send: jest.fn((data: string) => onSend(JSON.parse(data))),
  };
  (provider as any).ensureConnection = jest.fn().mockResolvedValue(socket);
  return socket;
}

async function collect<T>(generator: AsyncGenerator<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of generator) {
    values.push(value);
  }
  return values;
}

describe("AOReach", () => {
  const originalToken = process.env.AO_REACH_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.AO_REACH_TOKEN;
    } else {
      process.env.AO_REACH_TOKEN = originalToken;
    }
  });

  it("derives a workspace-scoped session and exposes the overlay as the model", async () => {
    const provider = createProvider();

    expect((provider as any).sessionId).toBe(
      "continue-comstar-sample-workspace",
    );
    await expect(provider.listModels()).resolves.toEqual(["comstar-code"]);
  });

  it("reads AO_REACH_TOKEN when apiKey is omitted", () => {
    process.env.AO_REACH_TOKEN = "environment-token";
    const provider = createProvider({ apiKey: undefined });

    expect(provider.apiKey).toBe("environment-token");
  });

  it("formats chat roles without adding provider-specific prompt syntax", () => {
    const provider = createProvider();
    const messages: ChatMessage[] = [
      { role: "system", content: "Follow the repository rules." },
      { role: "user", content: "Fix this function." },
    ];

    expect((provider as any).formatMessages(messages)).toBe(
      "<system>\nFollow the repository rules.\n<user>\nFix this function.",
    );
  });

  it("streams correlated delta and done frames", async () => {
    const provider = createProvider();
    attachSocket(provider, (frame) => {
      if (frame.type !== "query") {
        return;
      }
      queueMicrotask(() => {
        (provider as any).handleMessage(
          Buffer.from(
            JSON.stringify({
              type: "delta",
              turnId: frame.turnId,
              content: "first",
            }),
          ),
        );
        (provider as any).handleMessage(
          Buffer.from(
            JSON.stringify({
              type: "done",
              turnId: frame.turnId,
              content: " second",
            }),
          ),
        );
      });
    });

    const result = await collect(
      (provider as any)._streamChat(
        [{ role: "user", content: "hello" }],
        new AbortController().signal,
        {},
      ),
    );

    expect(result).toEqual([
      { role: "assistant", content: "first" },
      { role: "assistant", content: " second" },
    ]);
  });

  it("buffers frames when streaming is disabled", async () => {
    const provider = createProvider({ streamingEnabled: false });
    attachSocket(provider, (frame) => {
      if (frame.type !== "query") {
        return;
      }
      queueMicrotask(() => {
        for (const response of [
          { type: "delta", content: "one" },
          { type: "delta", content: " two" },
          { type: "done", content: " three" },
        ]) {
          (provider as any).handleMessage(
            Buffer.from(JSON.stringify({ ...response, turnId: frame.turnId })),
          );
        }
      });
    });

    const result = await collect(
      (provider as any)._streamChat(
        [{ role: "user", content: "hello" }],
        new AbortController().signal,
        {},
      ),
    );

    expect(result).toEqual([{ role: "assistant", content: "one two three" }]);
  });

  it("sends a cancel frame and stops when aborted", async () => {
    const provider = createProvider();
    const controller = new AbortController();
    const socket = attachSocket(provider, (frame) => {
      if (frame.type === "query") {
        queueMicrotask(() => controller.abort());
      }
    });

    const result = await collect(
      (provider as any)._streamChat(
        [{ role: "user", content: "hello" }],
        controller.signal,
        {},
      ),
    );

    expect(result).toEqual([]);
    expect(socket.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"cancel"'),
    );
  });

  it("surfaces the configured orchestration timeout", async () => {
    const provider = createProvider({ timeoutSeconds: 0.001 });
    attachSocket(provider, () => undefined);

    await expect(
      collect(
        (provider as any)._streamChat(
          [{ role: "user", content: "hello" }],
          new AbortController().signal,
          {},
        ),
      ),
    ).rejects.toThrow("Orchestration timed out after 0.001s");
  });
});
