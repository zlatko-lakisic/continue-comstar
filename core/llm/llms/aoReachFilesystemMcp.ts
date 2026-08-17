/**
 * Copyright 2023-2026 Continue Dev, Inc.
 * Licensed under the Apache License, Version 2.0.
 */

import fs from "fs";
import path from "path";

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

const TOOLS = [
  {
    name: "list_allowed_directories",
    description: "List directories this filesystem MCP may access",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_directory",
    description: "List files and directories at path",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "read_text_file",
    description: "Read a UTF-8 text file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        head: { type: "number" },
        tail: { type: "number" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write UTF-8 content to a file (creates parents)",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "create_directory",
    description: "Create a directory (recursive)",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "edit_file",
    description: "Apply sequential search/replace edits to a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string" },
              newText: { type: "string" },
            },
            required: ["oldText", "newText"],
          },
        },
        dryRun: { type: "boolean" },
      },
      required: ["path", "edits"],
    },
  },
  {
    name: "get_file_info",
    description: "Stat a file or directory",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "search_files",
    description: "Search for files by glob-like substring pattern under path",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        pattern: { type: "string" },
      },
      required: ["path", "pattern"],
    },
  },
  {
    name: "directory_tree",
    description: "Return a shallow JSON directory tree",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

/**
 * In-process Streamable HTTP MCP filesystem server for AO session tunnels.
 * Handles POST /mcp JSON-RPC (initialize, tools/list, tools/call).
 */
export class AoReachFilesystemMcp {
  private readonly allowlist: string[];

  constructor(allowlistDirs: string[]) {
    const resolved = allowlistDirs
      .map((dir) => path.resolve(dir))
      .filter((dir) => fs.existsSync(dir));
    if (resolved.length === 0) {
      throw new Error(
        "AO Reach filesystem tunnel requires at least one open workspace folder.",
      );
    }
    this.allowlist = resolved.map((dir) => fs.realpathSync(dir));
  }

  handleTunnelRequest(request: TunnelHttpRequest): TunnelHttpResponse {
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
          serverInfo: { name: "continue-comstar-filesystem", version: "1.0.0" },
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
        return this.callTool(id, rpc.params ?? {});
      case "ping":
        return jsonResponse(id, {});
      default:
        return jsonError(id, -32601, `Method not found: ${rpc.method}`);
    }
  }

  private callTool(
    id: JsonRpcId,
    params: Record<string, unknown>,
  ): TunnelHttpResponse {
    const name = String(params.name || "");
    const args = (params.arguments || {}) as Record<string, unknown>;
    try {
      switch (name) {
        case "list_allowed_directories":
          return jsonResponse(id, textContent(this.allowlist.join("\n")));
        case "list_directory": {
          const target = this.resolveAllowed(String(args.path || ""));
          const entries = fs.readdirSync(target, { withFileTypes: true });
          const lines = entries.map((entry) =>
            entry.isDirectory() ? `${entry.name}/` : entry.name,
          );
          return jsonResponse(id, textContent(lines.join("\n")));
        }
        case "read_file":
        case "read_text_file": {
          const target = this.resolveAllowed(String(args.path || ""));
          let text = fs.readFileSync(target, "utf8");
          if (typeof args.head === "number" && args.head >= 0) {
            text = text.split(/\r?\n/).slice(0, args.head).join("\n");
          } else if (typeof args.tail === "number" && args.tail >= 0) {
            const lines = text.split(/\r?\n/);
            text = lines
              .slice(Math.max(0, lines.length - args.tail))
              .join("\n");
          }
          return jsonResponse(id, textContent(text));
        }
        case "write_file": {
          const target = this.resolveAllowed(String(args.path || ""), true);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, String(args.content ?? ""), "utf8");
          return jsonResponse(id, textContent(`Wrote ${target}`));
        }
        case "create_directory": {
          const target = this.resolveAllowed(String(args.path || ""), true);
          fs.mkdirSync(target, { recursive: true });
          return jsonResponse(id, textContent(`Created ${target}`));
        }
        case "edit_file": {
          const target = this.resolveAllowed(String(args.path || ""));
          let text = fs.readFileSync(target, "utf8");
          const edits = Array.isArray(args.edits) ? args.edits : [];
          for (const edit of edits) {
            const oldText = String((edit as any)?.oldText ?? "");
            const newText = String((edit as any)?.newText ?? "");
            if (!oldText || !text.includes(oldText)) {
              throw new Error(`edit_file: oldText not found in ${target}`);
            }
            text = text.replace(oldText, newText);
          }
          if (!args.dryRun) {
            fs.writeFileSync(target, text, "utf8");
          }
          return jsonResponse(
            id,
            textContent(args.dryRun ? text : `Edited ${target}`),
          );
        }
        case "get_file_info": {
          const target = this.resolveAllowed(String(args.path || ""));
          const st = fs.statSync(target);
          return jsonResponse(
            id,
            textContent(
              JSON.stringify(
                {
                  path: target,
                  size: st.size,
                  isFile: st.isFile(),
                  isDirectory: st.isDirectory(),
                  mtime: st.mtime.toISOString(),
                },
                null,
                2,
              ),
            ),
          );
        }
        case "search_files": {
          const root = this.resolveAllowed(String(args.path || ""));
          const pattern = String(args.pattern || "").toLowerCase();
          const matches: string[] = [];
          const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                walk(full);
              } else if (entry.name.toLowerCase().includes(pattern)) {
                matches.push(full);
              }
            }
          };
          walk(root);
          return jsonResponse(id, textContent(matches.join("\n")));
        }
        case "directory_tree": {
          const root = this.resolveAllowed(String(args.path || ""));
          const build = (dir: string): unknown => {
            const children = fs
              .readdirSync(dir, { withFileTypes: true })
              .map((entry) => {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                  return {
                    name: entry.name,
                    type: "directory",
                    children: build(full),
                  };
                }
                return { name: entry.name, type: "file" };
              });
            return children;
          };
          return jsonResponse(
            id,
            textContent(JSON.stringify(build(root), null, 2)),
          );
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

  private resolveAllowed(inputPath: string, allowCreate = false): string {
    if (!inputPath?.trim()) {
      throw new Error("path is required");
    }
    const absolute = path.resolve(inputPath);
    let candidate = absolute;
    if (!fs.existsSync(candidate)) {
      if (!allowCreate) {
        throw new Error(`Path does not exist: ${inputPath}`);
      }
      candidate = path.dirname(absolute);
      while (
        !fs.existsSync(candidate) &&
        path.dirname(candidate) !== candidate
      ) {
        candidate = path.dirname(candidate);
      }
    }
    const real = fs.realpathSync(candidate);
    const realTarget = fs.existsSync(absolute)
      ? fs.realpathSync(absolute)
      : path.join(real, path.relative(candidate, absolute));

    const allowed = this.allowlist.some((root) => {
      const rel = path.relative(root, realTarget);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
    if (!allowed) {
      throw new Error(
        `Path escapes workspace allowlist: ${inputPath}. Allowed: ${this.allowlist.join(", ")}`,
      );
    }
    return fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute;
  }
}
