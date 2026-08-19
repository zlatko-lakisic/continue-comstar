/**
 * Copyright 2023-2026 Continue Dev, Inc.
 * Licensed under the Apache License, Version 2.0.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "node:child_process";
import iconv from "iconv-lite";
import { fileURLToPath } from "url";

export interface TunnelHttpRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

export interface TunnelHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

function jsonResponse(id: JsonRpcId, result: unknown): TunnelHttpResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }),
      "utf8",
    ),
  };
}

function jsonError(
  id: JsonRpcId,
  code: number,
  message: string,
): TunnelHttpResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: id ?? null,
        error: { code, message },
      }),
      "utf8",
    ),
  };
}

function textContent(text: string) {
  return { content: [{ type: "text", text }] };
}

const TERMINAL_TOOL_RESULT_CHARS = 8000;

function capToolText(text: string, maxChars = TERMINAL_TOOL_RESULT_CHARS) {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 14)}\n… truncated`;
}

function toLocalPath(dir: string): string | undefined {
  const trimmed = dir.trim();
  if (!trimmed.startsWith("file://")) {
    return trimmed;
  }
  try {
    return fileURLToPath(trimmed);
  } catch {
    return undefined;
  }
}

function getPreferredShell(): { shell: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      shell: "powershell.exe",
      args: ["-NoLogo", "-ExecutionPolicy", "Bypass", "-Command"],
    };
  }
  const userShell = process.env.SHELL || "/bin/bash";
  return { shell: userShell, args: ["-l", "-c"] };
}

function decodeOutput(data: Buffer): string {
  // PowerShell often emits UTF-16LE; try UTF-8 first, then fall back.
  if (process.platform === "win32") {
    const utf8 = iconv.decode(data, "utf8");
    if (!utf8.includes("�")) {
      return utf8;
    }
    try {
      return iconv.decode(data, "utf16le");
    } catch {
      return iconv.decode(data, "gbk");
    }
  }
  return data.toString("utf8");
}

export class AoReachTerminalMcp {
  private readonly workspaceDirs: string[];

  constructor(allowlistDirs: string[]) {
    const resolved = allowlistDirs
      .map((dir) => toLocalPath(dir))
      .filter((dir): dir is string => Boolean(dir))
      .map((dir) => path.resolve(dir))
      .filter((dir) => fs.existsSync(dir));

    if (resolved.length === 0) {
      throw new Error(
        `AO Reach terminal tunnel requires at least one open workspace folder (received: ${
          allowlistDirs.length ? allowlistDirs.join(", ") : "none"
        }).`,
      );
    }
    this.workspaceDirs = resolved.map((d) => fs.realpathSync(d));
  }

  async handleTunnelRequest(
    request: TunnelHttpRequest,
  ): Promise<TunnelHttpResponse> {
    const method = (request.method || "POST").toUpperCase();
    let reqPath = request.path || "/mcp";
    if (reqPath === "" || reqPath === "/") {
      reqPath = "/mcp";
    }
    if (!reqPath.startsWith("/")) {
      reqPath = `/${reqPath}`;
    }

    if (method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers":
            "content-type, accept, mcp-session-id",
        },
        body: Buffer.alloc(0),
      };
    }

    if (method !== "POST" || reqPath !== "/mcp") {
      return {
        status: 404,
        headers: { "content-type": "text/plain" },
        body: Buffer.from("Not Found", "utf8"),
      };
    }

    let rpc: JsonRpcRequest;
    try {
      const raw =
        typeof request.body === "string"
          ? request.body
          : (request.body?.toString("utf8") ?? "");
      rpc = JSON.parse(raw || "{}") as JsonRpcRequest;
    } catch {
      return jsonError(null, -32700, "Parse error");
    }

    const id = rpc.id ?? null;
    switch (rpc.method) {
      case "initialize":
        return jsonResponse(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "continue-comstar-terminal", version: "1.0.0" },
        });
      case "notifications/initialized":
      case "initialized":
        return {
          status: 202,
          headers: { "content-type": "application/json" },
          body: Buffer.alloc(0),
        };
      case "tools/list":
        return jsonResponse(id, { tools: TOOLS });
      case "tools/call":
        return await this.callTool(id, rpc.params ?? {});
      case "ping":
        return jsonResponse(id, {});
      default:
        return jsonError(id, -32601, `Method not found: ${rpc.method}`);
    }
  }

  private async callTool(
    id: JsonRpcId,
    params: Record<string, unknown>,
  ): Promise<TunnelHttpResponse> {
    const name = String(params.name || "");
    const args = (params.arguments || {}) as Record<string, unknown>;

    try {
      switch (name) {
        case "run_terminal_command": {
          const command = String(args.command || "").trim();
          const waitForCompletion =
            typeof args.waitForCompletion === "boolean"
              ? args.waitForCompletion
              : true;
          const timeoutMs =
            typeof args.timeoutMs === "number" &&
            Number.isFinite(args.timeoutMs) &&
            args.timeoutMs > 0
              ? Math.floor(args.timeoutMs)
              : 120_000;

          if (!command) {
            return jsonResponse(id, textContent("Error: command is required"));
          }

          const { shell, args: shellArgs } = getPreferredShell();
          const fullArgs =
            process.platform === "win32"
              ? [...shellArgs, command]
              : [...shellArgs, command];

          const cwd = this.workspaceDirs[0] ?? os.tmpdir();

          return await this.runCommand(id, {
            shell,
            args: fullArgs,
            cwd,
            waitForCompletion,
            timeoutMs,
          });
        }
        default:
          return jsonError(id, -32601, `Unknown tool: ${name}`);
      }
    } catch (error) {
      return jsonResponse(id, {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      });
    }
  }

  private runCommand(
    id: JsonRpcId,
    opts: {
      shell: string;
      args: string[];
      cwd: string;
      waitForCompletion: boolean;
      timeoutMs: number;
    },
  ): Promise<TunnelHttpResponse> {
    const { shell, args, cwd, waitForCompletion, timeoutMs } = opts;

    return new Promise((resolve) => {
      const childProc = spawn(shell, args, {
        cwd,
        env: {
          ...process.env,
          FORCE_COLOR: "1",
          COLORTERM: "truecolor",
          TERM: "xterm-256color",
          CLICOLOR: "1",
          CLICOLOR_FORCE: "1",
        },
        windowsHide: true,
      });

      if (!waitForCompletion) {
        childProc.unref();
        resolve(
          jsonResponse(
            id,
            textContent(
              `Command is running in the background (pid ${childProc.pid}).`,
            ),
          ),
        );
        return;
      }

      let stdout = "";
      let stderr = "";

      childProc.stdout?.on("data", (data) => {
        stdout += decodeOutput(data as Buffer);
      });
      childProc.stderr?.on("data", (data) => {
        stderr += decodeOutput(data as Buffer);
      });

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        try {
          childProc.kill("SIGTERM");
        } catch {
          // ignore
        }
        setTimeout(() => {
          try {
            childProc.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, 5000);
      }, timeoutMs);

      childProc.on("error", (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        resolve(
          jsonResponse(
            id,
            textContent(err instanceof Error ? err.message : String(err)),
          ),
        );
      });

      childProc.on("close", () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        let out = `${stdout}${stderr}`;
        if (timedOut) {
          out += "\n[Timeout: command killed]";
        }
        resolve(jsonResponse(id, textContent(capToolText(out))));
      });
    });
  }
}

const TOOLS = [
  {
    name: "run_terminal_command",
    description:
      "Run a terminal command (workspace root is the working directory).",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Command to execute in the IDE terminal shell.",
        },
        waitForCompletion: {
          type: "boolean",
          description: "Whether to wait; default true.",
        },
        timeoutMs: {
          type: "number",
          description: "Timeout in milliseconds; default 120000.",
        },
      },
      required: ["command"],
    },
  },
];
