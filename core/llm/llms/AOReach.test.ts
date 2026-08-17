/**
 * Copyright 2023-2026 Continue Dev, Inc.
 * Licensed under the Apache License, Version 2.0.
 */

import fs from "fs";
import os from "os";
import path from "path";

import WebSocket from "ws";

import { ChatMessage, LLMOptions } from "../../index.js";
import AOReach from "./AOReach.js";
import { AoReachFilesystemMcp } from "./aoReachFilesystemMcp.js";
import { loadReachMtlsMaterial, assertMtlsUsesTls } from "./aoReachMtls.js";
import { packSessionOverlay } from "./aoReachOverlay.js";

function clientId(bare: string): string {
  return bare.startsWith("client.") ? bare : `client.${bare}`;
}

function createProvider(overrides: Partial<LLMOptions> = {}): AOReach {
  const overlayRoot = path.resolve(
    process.cwd().endsWith("core") ? "../overlays" : "overlays",
  );
  return new AOReach({
    model: "",
    baseUrl: "ws://ao.test",
    apiKey: "test-token",
    sessionOverlay: "comstar-code",
    workspaceName: "sample-workspace",
    workspaceDirs: [process.cwd()],
    overlayRoot,
    filesystemTunnel: true,
    ...overrides,
  } as LLMOptions);
}

async function collect<T>(generator: AsyncGenerator<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of generator) {
    values.push(value);
  }
  return values;
}

describe("AOReach overlay packer", () => {
  it("rewrites bare agent ids to client.* and includes filesystem MCP", () => {
    const overlayRoot = path.resolve(
      process.cwd(),
      process.cwd().endsWith("core") ? "../overlays" : "overlays",
    );
    const packed = packSessionOverlay("comstar-code", {
      overlayRoot,
      includeFilesystemMcp: true,
    });
    expect(packed.agentIds).toContain("client.code_assistant");
    expect(packed.mcps[0]?.id).toBe("client.filesystem_local");
    expect(clientId("code_assistant")).toBe("client.code_assistant");
  });
});

describe("AOReach mTLS loader", () => {
  it("rejects non-TLS base URLs when material is configured", () => {
    expect(() => assertMtlsUsesTls("ws://ao.test")).toThrow(/https|wss/);
  });

  it("loads cert.pem key.pem ca.pem from a material dir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mtls-"));
    fs.writeFileSync(path.join(dir, "cert.pem"), "CERT");
    fs.writeFileSync(path.join(dir, "key.pem"), "KEY");
    fs.writeFileSync(path.join(dir, "ca.pem"), "CA");
    const material = loadReachMtlsMaterial(dir);
    expect(material.cert).toBe("CERT");
    expect(material.key).toBe("KEY");
    expect(material.ca).toBe("CA");
  });

  it("fails when material files are missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mtls-missing-"));
    expect(() => loadReachMtlsMaterial(dir)).toThrow(/mTLS material missing/);
  });
});

describe("AOReach in-process filesystem MCP", () => {
  it("sandboxes paths and supports read/list/write", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-fs-"));
    fs.writeFileSync(path.join(root, "hello.txt"), "hi");
    const mcp = new AoReachFilesystemMcp([root]);

    const listed = mcp.handleTunnelRequest({
      method: "POST",
      path: "/mcp",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "list_directory",
          arguments: { path: root },
        },
      }),
    });
    expect(listed.status).toBe(200);
    expect(listed.body.toString("utf8")).toContain("hello.txt");

    const read = mcp.handleTunnelRequest({
      method: "POST",
      path: "/mcp",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "read_file",
          arguments: { path: path.join(root, "hello.txt") },
        },
      }),
    });
    expect(read.body.toString("utf8")).toContain("hi");

    const escaped = mcp.handleTunnelRequest({
      method: "POST",
      path: "/mcp",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "read_file",
          arguments: { path: path.join(root, "..", "outside.txt") },
        },
      }),
    });
    expect(escaped.body.toString("utf8")).toMatch(
      /escape|does not exist|Path/i,
    );
  });
});

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

  it("streams thought then stdout and finishes on run_end", async () => {
    const provider = createProvider();
    const sent: Record<string, unknown>[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send: jest.fn((data: string) => sent.push(JSON.parse(data))),
    };
    (provider as any).ensureConnection = jest.fn().mockResolvedValue(socket);
    (provider as any).packed = {
      agentIds: ["client.code_assistant"],
      agents: [],
      skills: [],
      mcps: [],
    };

    const gen = (provider as any)._streamChat(
      [{ role: "user", content: "hi" }],
      new AbortController().signal,
      {},
    );

    const pump = (async () => {
      // wait until chat is sent
      for (let i = 0; i < 20 && sent.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const chat = sent.find((f) => f.type === "chat") as {
        questionId: string;
      };
      const qid = chat.questionId;
      const state = (provider as any).turns.get(qid);
      state.frames.push({
        type: "chunk",
        stream: "thought",
        text: "planning…",
        question_id: qid,
      });
      state.wake?.();
      await new Promise((r) => setTimeout(r, 5));
      state.frames.push({
        type: "chunk",
        stream: "stdout",
        text: "Hello",
        question_id: qid,
      });
      state.wake?.();
      await new Promise((r) => setTimeout(r, 5));
      state.frames.push({
        type: "chunk",
        stream: "stdout",
        text: " world",
        question_id: qid,
      });
      state.wake?.();
      await new Promise((r) => setTimeout(r, 5));
      state.frames.push({
        type: "run_end",
        ok: true,
        question_id: qid,
      });
      state.wake?.();
    })();

    const messages = (await collect(gen)) as ChatMessage[];
    await pump;
    expect(messages[0]).toEqual({ role: "thinking", content: "planning…" });
    expect(
      messages.filter((m) => m.role === "assistant").map((m) => m.content),
    ).toEqual(["Hello", " world"]);
    expect(sent.some((f) => f.type === "chat")).toBe(true);
  });

  it("sends cancel on abort without closing the socket", async () => {
    const provider = createProvider();
    const sent: Record<string, unknown>[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send: jest.fn((data: string) => sent.push(JSON.parse(data))),
      terminate: jest.fn(),
    };
    (provider as any).ensureConnection = jest.fn().mockResolvedValue(socket);
    (provider as any).packed = {
      agentIds: ["client.code_assistant"],
      agents: [],
      skills: [],
      mcps: [],
    };

    const controller = new AbortController();
    const gen = (provider as any)._streamChat(
      [{ role: "user", content: "hi" }],
      controller.signal,
      {},
    );

    const runner = collect(gen);
    for (let i = 0; i < 20 && sent.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const chat = sent.find((f) => f.type === "chat") as { questionId: string };
    controller.abort();
    await runner;
    expect(
      sent.some((f) => f.type === "cancel" && f.questionId === chat.questionId),
    ).toBe(true);
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it("sends cancel on timeout", async () => {
    const provider = createProvider({ timeoutSeconds: 0.05 } as any);
    const sent: Record<string, unknown>[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send: jest.fn((data: string) => sent.push(JSON.parse(data))),
    };
    (provider as any).ensureConnection = jest.fn().mockResolvedValue(socket);
    (provider as any).packed = {
      agentIds: ["client.code_assistant"],
      agents: [],
      skills: [],
      mcps: [],
    };

    await expect(
      collect(
        (provider as any)._streamChat(
          [{ role: "user", content: "hi" }],
          new AbortController().signal,
          {},
        ),
      ),
    ).rejects.toThrow(/timed out/i);
    expect(sent.some((f) => f.type === "cancel")).toBe(true);
  });
});
