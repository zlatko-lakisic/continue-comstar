/**
 * Copyright 2023-2026 Continue Dev, Inc.
 * Licensed under the Apache License, Version 2.0.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";

import WebSocket from "ws";

import { ChatMessage, LLMOptions } from "../../index.js";
import AOReach from "./AOReach.js";
import { AoReachFilesystemMcp } from "./aoReachFilesystemMcp.js";
import { loadReachMtlsMaterial, assertMtlsUsesTls } from "./aoReachMtls.js";
import { packAgentDefinition, packSessionOverlay } from "./aoReachOverlay.js";

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

  it("packs a single agent YAML via agentDefinition", () => {
    const yamlPath = path.resolve(
      process.cwd(),
      process.cwd().endsWith("core")
        ? "../overlays/comstar-code/agent_providers/code_assistant.yaml"
        : "overlays/comstar-code/agent_providers/code_assistant.yaml",
    );
    const packed = packAgentDefinition(yamlPath, { includeFilesystemMcp: true });
    expect(packed.agentIds).toEqual(["client.code_assistant"]);
    expect(packed.agents).toHaveLength(1);
    expect(packed.mcps[0]?.id).toBe("client.filesystem_local");
  });

  it("packs an overlay folder via agentDefinition", () => {
    const dir = path.resolve(
      process.cwd(),
      process.cwd().endsWith("core")
        ? "../overlays/comstar-code"
        : "overlays/comstar-code",
    );
    const packed = packAgentDefinition(dir, { includeFilesystemMcp: false });
    expect(packed.agentIds).toContain("client.code_assistant");
    expect(packed.mcps).toHaveLength(0);
  });

  it("constructs AOReach from agentDefinition without sessionOverlay", () => {
    const yamlPath = path.resolve(
      process.cwd(),
      process.cwd().endsWith("core")
        ? "../overlays/comstar-code/agent_providers/code_assistant.yaml"
        : "overlays/comstar-code/agent_providers/code_assistant.yaml",
    );
    const prevMtls = process.env.AO_REACH_MTLS_DIR;
    delete process.env.AO_REACH_MTLS_DIR;
    try {
      const provider = new AOReach({
        model: "",
        baseUrl: "ws://ao.test",
        apiKey: "test-token",
        agentDefinition: yamlPath,
        workspaceName: "sample-workspace",
        workspaceDirs: [process.cwd()],
        filesystemTunnel: true,
      } as LLMOptions);
      expect(provider.agentDefinition).toBe(yamlPath);
      expect(provider.sessionOverlay).toBe("code_assistant");
    } finally {
      if (prevMtls !== undefined) {
        process.env.AO_REACH_MTLS_DIR = prevMtls;
      }
    }
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

  it("accepts file:// workspace URIs from the IDE", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-fs-uri-"));
    fs.writeFileSync(path.join(root, "hello.txt"), "hi");
    const mcp = new AoReachFilesystemMcp([pathToFileURL(root).toString()]);

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
    expect(listed.body.toString("utf8")).toContain("hello.txt");
  });

  it("reports the received dirs when none are usable", () => {
    expect(() => new AoReachFilesystemMcp([])).toThrow(/received: none/);
  });
});

describe("AOReach", () => {
  const originalToken = process.env.AO_REACH_TOKEN;
  const originalMtlsDir = process.env.AO_REACH_MTLS_DIR;

  beforeEach(() => {
    delete process.env.AO_REACH_MTLS_DIR;
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.AO_REACH_TOKEN;
    } else {
      process.env.AO_REACH_TOKEN = originalToken;
    }
    if (originalMtlsDir === undefined) {
      delete process.env.AO_REACH_MTLS_DIR;
    } else {
      process.env.AO_REACH_MTLS_DIR = originalMtlsDir;
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

  it("sends cancel when AO goes silent for the idle budget", async () => {
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
    ).rejects.toThrow(/stopped reporting progress/i);
    expect(sent.some((f) => f.type === "cancel")).toBe(true);
  });

  it("keeps waiting while AO reports progress and shows it as thinking", async () => {
    // Idle budget far shorter than the run: only re-arming on each frame keeps
    // this alive, which is what lets multi-minute orchestrations finish.
    const provider = createProvider({ timeoutSeconds: 0.12 } as any);
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
    const runner = collect(gen);

    for (let i = 0; i < 40 && sent.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const qid = (sent.find((f) => f.type === "chat") as { questionId: string })
      .questionId;

    const push = async (frame: Record<string, unknown>) => {
      await (provider as any).onSocketMessage(
        socket,
        JSON.stringify({ ...frame, question_id: qid }),
      );
    };

    for (let beat = 1; beat <= 5; beat++) {
      await new Promise((r) => setTimeout(r, 60));
      await push({
        type: "status",
        processing: true,
        phase: "executing",
        message: `Working through 3 steps… (${beat * 10}s)`,
        heartbeat: beat > 1,
      });
    }
    await push({
      type: "status",
      processing: true,
      phase: "step",
      message: "Working with code assistant…",
      step: 2,
      stepCount: 3,
    });
    // Repeated status must not duplicate the line in the thinking pane.
    await push({
      type: "status",
      processing: true,
      phase: "step",
      message: "Working with code assistant…",
      step: 2,
      stepCount: 3,
    });
    await push({ type: "run_end", ok: true });

    const messages = (await runner) as ChatMessage[];
    const thinking = messages
      .filter((m) => m.role === "thinking")
      .map((m) => String(m.content));
    expect(thinking).toHaveLength(6);
    expect(thinking[0]).toBe("Working through 3 steps… (10s)\n");
    expect(thinking[5]).toBe("[2/3] Working with code assistant…\n");
    expect(sent.some((f) => f.type === "cancel")).toBe(false);
  });

  it("never times out when timeoutSeconds is 0", async () => {
    const provider = createProvider({ timeoutSeconds: 0 } as any);
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
    const runner = collect(gen);

    for (let i = 0; i < 40 && sent.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const qid = (sent.find((f) => f.type === "chat") as { questionId: string })
      .questionId;

    await new Promise((r) => setTimeout(r, 250));
    expect(sent.some((f) => f.type === "cancel")).toBe(false);

    await (provider as any).onSocketMessage(
      socket,
      JSON.stringify({ type: "run_end", ok: true, question_id: qid }),
    );
    await expect(runner).resolves.toBeDefined();
  });
});
