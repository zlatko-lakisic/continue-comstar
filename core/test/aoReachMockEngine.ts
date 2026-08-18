/**
 * In-process engine-ws/1 stand-in for AOReach tests.
 *
 * Speaks the same frames the VS Code plugin sends and receives so we can
 * assert the client understands every type without a live AO.
 */

import http from "http";
import path from "path";
import { AddressInfo } from "net";
import { WebSocket, WebSocketServer } from "ws";

export type EngineFrame = Record<string, unknown>;

export type MockScenario =
  | "happy"
  | "fastapi-error"
  | "overlay-denied"
  | "overlay-disabled"
  | "tunnel-disabled"
  | "hang";

export interface MockAoEngine {
  url: string;
  clientFrames: EngineFrame[];
  close(): Promise<void>;
  waitForClient(type: string, timeoutMs?: number): Promise<EngineFrame>;
}

interface StartOptions {
  scenario?: MockScenario;
  token?: string;
}

function jsonRpc(method: string, id: number, params?: Record<string, unknown>) {
  return Buffer.from(
    JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }),
    "utf8",
  ).toString("base64");
}

function send(socket: WebSocket, frame: EngineFrame) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}

export async function startMockAoEngine(
  options: StartOptions = {},
): Promise<MockAoEngine> {
  const scenario: MockScenario = options.scenario || "happy";
  const expectedToken = options.token;
  const clientFrames: EngineFrame[] = [];
  const waiters: Array<{
    type: string;
    resolve: (frame: EngineFrame) => void;
  }> = [];

  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket, request) => {
    if (expectedToken) {
      const auth = String(request.headers.authorization || "");
      if (auth !== `Bearer ${expectedToken}`) {
        socket.close(1008, "auth failed");
        return;
      }
    }

    const overlayOn = scenario !== "overlay-disabled";
    const tunnelOn = scenario !== "tunnel-disabled";
    send(socket, {
      type: "hello",
      service: "agentic-orchestration-engine",
      protocol: "engine-ws/1",
      questionTags: true,
      sessionOverlay: overlayOn,
      mcpTunnel: tunnelOn,
      userName: "tester",
      sessionId: "s1",
      userId: "tester",
    });

    // Unsolicited types the plugin must ignore without aborting the session.
    send(socket, {
      type: "host_metrics",
      cpu: { percent: 4 },
      memory: { usedPercent: 16 },
    });

    const runChat = async (frame: EngineFrame) => {
      const qid = String(frame.questionId || frame.question_id || "");
      const tag = { question_id: qid, run_id: `run-${qid.slice(0, 8)}` };

      send(socket, {
        type: "preflight",
        status: "done",
        message: "Engine warm.",
        ...tag,
      });
      send(socket, {
        type: "run_start",
        mode: "chat",
        text: String(frame.text || ""),
        processing: true,
        ...tag,
      });
      send(socket, {
        type: "status",
        processing: true,
        phase: "starting",
        message: "Starting your request…",
        ...tag,
      });
      send(socket, {
        type: "status",
        processing: true,
        phase: "planning",
        message: "Planning the next step…",
        heartbeat: true,
        elapsedMs: 10000,
        ...tag,
      });
      send(socket, {
        type: "chunk",
        stream: "stderr",
        text: "(engine) warming agents\n",
        ...tag,
      });
      send(socket, {
        type: "chunk",
        stream: "thought",
        text: "Looking through the workspace…",
        ...tag,
      });

      if (scenario === "hang") {
        return;
      }

      if (scenario === "fastapi-error") {
        send(socket, {
          type: "status",
          processing: false,
          phase: "error",
          message: "No module named 'fastapi'",
          detail: "No module named 'fastapi'",
          code: "run_failed",
          ...tag,
        });
        send(socket, {
          type: "error",
          message: "No module named 'fastapi'",
          processing: false,
          phase: "error",
          code: "run_failed",
          ...tag,
        });
        send(socket, {
          type: "run_end",
          ok: false,
          exitCode: 1,
          error: "No module named 'fastapi'",
          code: "run_failed",
          processing: false,
          ...tag,
        });
        return;
      }

      // Filesystem MCP round-trip the plugin must answer in-process.
      const requestId = `mcp-${qid}`;
      send(socket, {
        type: "mcp_tunnel_request",
        requestId,
        mcpId: "client.filesystem_local",
        tunnelPath: "filesystem",
        method: "POST",
        path: "/mcp",
        headers: { "content-type": "application/json" },
        bodyBase64: jsonRpc("tools/list", 1),
      });

      const tunnel = await waitFor(
        clientFrames,
        waiters,
        "mcp_tunnel_response",
        2000,
      ).catch(() => undefined);
      void tunnel;

      send(socket, {
        type: "status",
        processing: true,
        phase: "step",
        message: "Working with code assistant…",
        step: 1,
        stepCount: 1,
        ...tag,
      });
      send(socket, {
        type: "chunk",
        stream: "stdout",
        text: "pong",
        ...tag,
      });
      send(socket, {
        type: "status",
        processing: false,
        phase: "done",
        message: "Done.",
        ...tag,
      });
      send(socket, {
        type: "run_end",
        ok: true,
        exitCode: 0,
        processing: false,
        ...tag,
      });
    };

    socket.on("message", (data) => {
      let frame: EngineFrame;
      try {
        frame = JSON.parse(data.toString()) as EngineFrame;
      } catch {
        send(socket, { type: "error", message: "Invalid JSON message" });
        return;
      }
      clientFrames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].type === String(frame.type || "")) {
          waiters[i].resolve(frame);
          waiters.splice(i, 1);
        }
      }

      const type = String(frame.type || "");
      if (type === "ping") {
        send(socket, { type: "pong" });
        return;
      }
      if (type === "session_overlay_register") {
        if (scenario === "overlay-denied") {
          send(socket, {
            type: "session_overlay_denied",
            error: "denied",
            message: "overlay rejected by engine",
          });
          return;
        }
        send(socket, {
          type: "session_overlay_ack",
          agentIds: ["client.code_assistant"],
          mcpIds: tunnelOn ? ["client.filesystem_local"] : [],
          skillIds: [],
        });
        return;
      }
      if (type === "session_overlay_clear") {
        send(socket, { type: "session_overlay_cleared" });
        return;
      }
      if (type === "rate") {
        send(socket, { type: "rated", ok: true });
        return;
      }
      if (type === "chat" || type === "direct_agent") {
        void runChat(frame);
        return;
      }
      if (type === "cancel") {
        const qid = String(frame.questionId || frame.question_id || "");
        send(socket, {
          type: "status",
          processing: false,
          phase: "cancelled",
          message: "Cancelled.",
          code: "cancelled",
          question_id: qid,
        });
        send(socket, {
          type: "run_end",
          ok: false,
          code: "cancelled",
          processing: false,
          question_id: qid,
        });
        return;
      }
      if (type === "mcp_tunnel_response") {
        return;
      }
      send(socket, {
        type: "error",
        message: `Unknown message type: ${type}`,
      });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${addr.port}`,
    clientFrames,
    waitForClient: (type, timeoutMs = 2000) =>
      waitFor(clientFrames, waiters, type, timeoutMs),
    close: async () => {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function waitFor(
  frames: EngineFrame[],
  waiters: Array<{ type: string; resolve: (frame: EngineFrame) => void }>,
  type: string,
  timeoutMs: number,
): Promise<EngineFrame> {
  const existing = frames.find((f) => f.type === type);
  if (existing) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for client frame type=${type}`));
    }, timeoutMs);
    waiters.push({
      type,
      resolve: (frame) => {
        clearTimeout(timer);
        resolve(frame);
      },
    });
  });
}

export function overlayRoot(): string {
  return process.cwd().endsWith("core")
    ? path.resolve(process.cwd(), "../overlays")
    : path.resolve(process.cwd(), "overlays");
}
