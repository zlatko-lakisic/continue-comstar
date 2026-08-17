/**
 * Copyright 2023-2026 Continue Dev, Inc.
 * Licensed under the Apache License, Version 2.0.
 */

import { v4 as uuidv4 } from "uuid";
import WebSocket, { RawData } from "ws";

import { ChatMessage, CompletionOptions, LLMOptions } from "../../index.js";
import { Logger } from "../../util/Logger.js";
import { renderChatMessage } from "../../util/messageContent.js";
import { BaseLLM } from "../index.js";
import { AoReachFilesystemMcp } from "./aoReachFilesystemMcp.js";
import {
  assertMtlsUsesTls,
  loadReachMtlsMaterial,
  resolveMtlsMaterialDir,
  ReachMtlsMaterial,
} from "./aoReachMtls.js";
import { packSessionOverlay, PackedOverlay } from "./aoReachOverlay.js";

const APP_ID = "continue-comstar";
const OVERLAY_TTL_SECONDS = 3600;

type EngineFrame = Record<string, unknown>;

interface AOReachOptions extends LLMOptions {
  baseUrl: string;
  sessionOverlay: string;
  sessionId?: string;
  timeoutSeconds?: number;
  streamingEnabled?: boolean;
  workspaceName?: string;
  workspaceDirs?: string[];
  mtlsMaterialDir?: string;
  filesystemTunnel?: boolean;
  userName?: string;
  overlayRoot?: string;
}

interface TurnState {
  frames: EngineFrame[];
  wake?: () => void;
  error?: Error;
  aborted?: boolean;
  assistantBuffer: string;
}

class AOReach extends BaseLLM {
  static providerName = "ao_reach";
  static defaultOptions: Partial<LLMOptions> = {
    model: "ao_reach",
  };

  readonly baseUrl: string;
  readonly sessionOverlay: string;
  readonly sessionId: string;
  readonly timeoutSeconds: number;
  readonly streamingEnabled: boolean;
  readonly filesystemTunnel: boolean;
  readonly userName: string;
  readonly workspaceDirs: string[];
  readonly overlayRoot?: string;
  /** Resolved path after env fallback; keep off ILLM surface (config uses LLMOptions.mtlsMaterialDir). */
  private readonly resolvedMtlsDir?: string;
  private mtlsMaterial?: ReachMtlsMaterial;
  private socket?: WebSocket;
  private connectionPromise?: Promise<WebSocket>;
  private hello?: EngineFrame;
  private packed?: PackedOverlay;
  private filesystemMcp?: AoReachFilesystemMcp;
  private overlayRefreshTimer?: ReturnType<typeof setTimeout>;
  private readonly turns = new Map<string, TurnState>();

  constructor(options: LLMOptions) {
    super(options);

    const aoOptions = options as AOReachOptions;
    this.baseUrl = (aoOptions.baseUrl || aoOptions.apiBase || "").replace(
      /\/+$/,
      "",
    );
    this.sessionOverlay = aoOptions.sessionOverlay || "";
    this.timeoutSeconds = aoOptions.timeoutSeconds ?? 15;
    this.streamingEnabled = aoOptions.streamingEnabled ?? true;
    this.filesystemTunnel = aoOptions.filesystemTunnel ?? true;
    this.workspaceDirs = aoOptions.workspaceDirs ?? [];
    this.overlayRoot = aoOptions.overlayRoot;
    this.resolvedMtlsDir = resolveMtlsMaterialDir(aoOptions.mtlsMaterialDir);
    this.apiKey = this.resolveApiKey(aoOptions.apiKey);
    this.sessionId =
      aoOptions.sessionId ??
      `continue-comstar-${aoOptions.workspaceName || "workspace"}`;
    this.userName =
      aoOptions.userName ||
      process.env.AO_REACH_USER ||
      process.env.USERNAME ||
      process.env.USER ||
      "continue-comstar";

    if (!this.baseUrl) {
      throw new Error("AO Reach requires baseUrl in config.yaml.");
    }
    if (!this.apiKey) {
      throw new Error(
        "AO Reach requires apiKey in config.yaml or AO_REACH_TOKEN in the environment.",
      );
    }
    if (!this.sessionOverlay) {
      throw new Error("AO Reach requires sessionOverlay in config.yaml.");
    }
    if (!Number.isFinite(this.timeoutSeconds) || this.timeoutSeconds <= 0) {
      throw new Error("AO Reach timeoutSeconds must be greater than zero.");
    }
    if (this.resolvedMtlsDir) {
      assertMtlsUsesTls(this.baseUrl);
      this.mtlsMaterial = loadReachMtlsMaterial(this.resolvedMtlsDir);
    }
  }

  private resolveApiKey(configuredApiKey?: string): string | undefined {
    if (
      configuredApiKey &&
      configuredApiKey !== "$AO_REACH_TOKEN" &&
      configuredApiKey !== "${AO_REACH_TOKEN}"
    ) {
      return configuredApiKey;
    }
    return process.env.AO_REACH_TOKEN;
  }

  /** Build wss?://host/ws like Reach reachWsUri. */
  private getWsUrl(): string {
    let url: URL;
    try {
      url = new URL(this.baseUrl);
    } catch {
      throw new Error(
        `Invalid AO Reach baseUrl "${this.baseUrl}". Expected a ws(s):// or http(s):// URL.`,
      );
    }

    if (url.protocol === "http:") {
      url.protocol = "ws:";
    } else if (url.protocol === "https:") {
      url.protocol = "wss:";
    } else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Error(
        `Invalid AO Reach baseUrl "${this.baseUrl}". Expected a ws(s):// or http(s):// URL.`,
      );
    }

    url.pathname = "/ws";
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  private formatMessages(messages: ChatMessage[]): string {
    return messages
      .map((message) => `<${message.role}>\n${renderChatMessage(message)}`)
      .join("\n");
  }

  private async ensureConnection(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN && this.hello) {
      return this.socket;
    }
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = this.connectWithBackoff().finally(() => {
      this.connectionPromise = undefined;
    });
    return this.connectionPromise;
  }

  private async connectWithBackoff(): Promise<WebSocket> {
    const maxAttempts = 5;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const delayMs = 250 * 2 ** (attempt - 1);
        Logger.warn("AO Reach reconnect attempt", {
          attempt: attempt + 1,
          delayMs,
          baseUrl: this.baseUrl,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      try {
        return await this.openConnection();
      } catch (error) {
        lastError = error;
        if (this.isAuthError(error)) {
          throw this.authError();
        }
      }
    }

    const error = this.connectionError(lastError);
    Logger.error(error, { provider: AOReach.providerName });
    throw error;
  }

  private openConnection(): Promise<WebSocket> {
    const wsUrl = this.getWsUrl();

    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        "x-agentic-session-id": this.sessionId,
        "x-agentic-user-name": this.userName,
      };

      const socketOptions: WebSocket.ClientOptions = { headers };
      if (this.mtlsMaterial) {
        socketOptions.cert = this.mtlsMaterial.cert;
        socketOptions.key = this.mtlsMaterial.key;
        socketOptions.ca = this.mtlsMaterial.ca;
        socketOptions.rejectUnauthorized = true;
      }

      const socket = new WebSocket(wsUrl, socketOptions);
      let settled = false;
      let helloTimer: ReturnType<typeof setTimeout> | undefined;

      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (helloTimer) {
          clearTimeout(helloTimer);
        }
        socket.terminate();
        reject(error);
      };

      socket.once("unexpected-response", (_request, response) => {
        const statusCode = response.statusCode ?? 500;
        const error =
          statusCode === 1008 || (statusCode >= 400 && statusCode < 500)
            ? statusCode === 403 ||
              /certificate/i.test(String(response.statusMessage))
              ? new Error(
                  "AO Reach WebSocket rejected the connection (possible missing client certificate). Set mtlsMaterialDir / AO_REACH_MTLS_DIR to a folder with cert.pem, key.pem, and ca.pem.",
                )
              : this.authError()
            : new Error(
                `AO Reach WebSocket upgrade failed with HTTP ${statusCode}.`,
              );
        response.resume();
        fail(error);
      });

      socket.once("open", () => {
        helloTimer = setTimeout(() => {
          fail(
            new Error(
              "AO Reach did not send a hello frame. Is agentic-orchestration serving /ws?",
            ),
          );
        }, 10_000);
      });

      socket.on("message", (data) => {
        void this.onSocketMessage(socket, data, {
          onHello: async () => {
            if (settled) {
              return;
            }
            try {
              if (helloTimer) {
                clearTimeout(helloTimer);
              }
              await this.afterHello(socket);
              settled = true;
              this.socket = socket;
              resolve(socket);
            } catch (error) {
              fail(error instanceof Error ? error : new Error(String(error)));
            }
          },
        });
      });

      socket.on("close", (code, reason) => {
        if (this.socket === socket) {
          this.socket = undefined;
          this.hello = undefined;
        }
        this.clearOverlayRefresh();
        const reasonText = reason.toString();
        Logger.debug("AO Reach connection closed", {
          code,
          reason: reasonText,
          sessionId: this.sessionId,
        });
        const certHint =
          code === 1008 && /certificate|mTLS|mtls/i.test(reasonText)
            ? " Set mtlsMaterialDir / AO_REACH_MTLS_DIR to enrolled client material."
            : "";
        const error = new Error(
          `AO Reach connection closed before the response completed (${code}${reasonText ? `: ${reasonText}` : ""}).${certHint}`,
        );
        this.rejectAllTurns(error);
        if (!settled) {
          fail(error);
        }
      });

      socket.on("error", (error) => {
        if (!settled) {
          fail(error instanceof Error ? error : new Error(String(error)));
        } else {
          Logger.error(error, {
            provider: AOReach.providerName,
            baseUrl: this.baseUrl,
          });
        }
      });
    });
  }

  private async onSocketMessage(
    socket: WebSocket,
    data: RawData,
    hooks?: { onHello?: () => Promise<void> },
  ): Promise<void> {
    let frame: EngineFrame;
    try {
      frame = JSON.parse(data.toString()) as EngineFrame;
    } catch (error) {
      const parseError = new Error(
        `AO Reach returned an invalid response frame: ${error instanceof Error ? error.message : String(error)}`,
      );
      Logger.error(parseError, { provider: AOReach.providerName });
      this.rejectAllTurns(parseError);
      return;
    }

    const type = String(frame.type || "");
    if (type === "hello") {
      this.hello = frame;
      await hooks?.onHello?.();
      return;
    }

    if (type === "mcp_tunnel_request") {
      await this.handleTunnelRequest(socket, frame);
      return;
    }

    const questionId =
      (frame.question_id as string | undefined) ||
      (frame.questionId as string | undefined);
    if (!questionId) {
      if (type === "error") {
        Logger.warn("AO Reach untagged error frame", {
          message: frame.message,
        });
      }
      return;
    }

    const state = this.turns.get(questionId);
    if (!state) {
      return;
    }
    if (state.aborted) {
      return;
    }

    if (type === "error") {
      state.error = new Error(
        `AO Reach orchestration error: ${String(frame.message || "unknown error")}`,
      );
      state.wake?.();
      return;
    }

    state.frames.push(frame);
    state.wake?.();
  }

  private async afterHello(socket: WebSocket): Promise<void> {
    if (!this.hello) {
      throw new Error("AO Reach hello missing.");
    }
    if (this.hello.sessionOverlay !== true) {
      throw new Error(
        "AO Reach session overlays are disabled on the engine. Start agentic-orchestration with AGENTIC_SERVE_SESSION_OVERLAY=1.",
      );
    }
    if (this.filesystemTunnel && this.hello.mcpTunnel !== true) {
      throw new Error(
        "AO Reach MCP tunnel is disabled on the engine. Start agentic-orchestration with AGENTIC_SERVE_MCP_TUNNEL=1 (or set filesystemTunnel: false).",
      );
    }

    if (this.filesystemTunnel) {
      this.filesystemMcp = new AoReachFilesystemMcp(this.workspaceDirs);
    } else {
      this.filesystemMcp = undefined;
    }

    this.packed = packSessionOverlay(this.sessionOverlay, {
      overlayRoot: this.overlayRoot,
      includeFilesystemMcp: this.filesystemTunnel,
    });

    await this.registerOverlay(socket);
    this.scheduleOverlayRefresh();
    Logger.debug("AO Reach connection ready", {
      baseUrl: this.baseUrl,
      sessionId: this.sessionId,
      sessionOverlay: this.sessionOverlay,
      agentIds: this.packed.agentIds,
    });
  }

  private registerOverlay(socket: WebSocket): Promise<void> {
    if (!this.packed) {
      throw new Error("AO Reach overlay pack missing.");
    }
    const ackId = `overlay-ack-${uuidv4()}`;
    const state: TurnState = { frames: [], assistantBuffer: "" };
    // Use a synthetic waiter via a one-shot promise on raw socket messages for overlay ack.
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            "Timed out waiting for session_overlay_ack from agentic-orchestration.",
          ),
        );
      }, 30_000);

      const onMessage = (data: RawData) => {
        let frame: EngineFrame;
        try {
          frame = JSON.parse(data.toString()) as EngineFrame;
        } catch {
          return;
        }
        const type = String(frame.type || "");
        if (type === "session_overlay_ack") {
          cleanup();
          resolve();
          return;
        }
        if (type === "session_overlay_denied" || type === "error") {
          cleanup();
          reject(
            new Error(
              `AO Reach session overlay registration failed: ${String(frame.message || frame.error || type)}`,
            ),
          );
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("message", onMessage);
      };

      socket.on("message", onMessage);
      socket.send(
        JSON.stringify({
          type: "session_overlay_register",
          appId: APP_ID,
          ttlSeconds: OVERLAY_TTL_SECONDS,
          agents: this.packed!.agents,
          skills: this.packed!.skills,
          mcps: this.packed!.mcps,
          allowedAgentProviderIds: [],
          allowedMcpProviderIds: [],
          allowedSkillIds: [],
        }),
      );
      void ackId;
      void state;
    });
  }

  private scheduleOverlayRefresh(): void {
    this.clearOverlayRefresh();
    const refreshMs = Math.max(60_000, OVERLAY_TTL_SECONDS * 1000 * 0.8);
    this.overlayRefreshTimer = setTimeout(() => {
      void (async () => {
        try {
          const socket = await this.ensureConnection();
          await this.registerOverlay(socket);
          this.scheduleOverlayRefresh();
        } catch (error) {
          Logger.warn("AO Reach overlay refresh failed; will reconnect", {
            error: error instanceof Error ? error.message : String(error),
          });
          this.socket?.terminate();
          this.socket = undefined;
          this.hello = undefined;
        }
      })();
    }, refreshMs);
  }

  private clearOverlayRefresh(): void {
    if (this.overlayRefreshTimer) {
      clearTimeout(this.overlayRefreshTimer);
      this.overlayRefreshTimer = undefined;
    }
  }

  private async handleTunnelRequest(
    socket: WebSocket,
    frame: EngineFrame,
  ): Promise<void> {
    const requestId = String(frame.requestId || "");
    if (!requestId) {
      return;
    }
    try {
      if (!this.filesystemMcp) {
        throw new Error(
          "Filesystem MCP tunnel is not enabled for this session.",
        );
      }
      const method = String(frame.method || "POST");
      let reqPath = String(frame.path || "/mcp");
      if (reqPath === "" || reqPath === "/") {
        reqPath = "/mcp";
      }
      const bodyBase64 = String(frame.bodyBase64 || "");
      const body = bodyBase64
        ? Buffer.from(bodyBase64, "base64")
        : Buffer.alloc(0);
      const response = this.filesystemMcp.handleTunnelRequest({
        method,
        path: reqPath,
        headers: (frame.headers as Record<string, string>) || {},
        body,
      });
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "mcp_tunnel_response",
            requestId,
            status: response.status,
            headers: response.headers,
            bodyBase64: response.body.toString("base64"),
          }),
        );
      }
    } catch (error) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "mcp_tunnel_response",
            requestId,
            status: 500,
            headers: { "content-type": "text/plain" },
            bodyBase64: Buffer.from(
              error instanceof Error ? error.message : String(error),
              "utf8",
            ).toString("base64"),
          }),
        );
      }
    }
  }

  private rejectAllTurns(error: Error): void {
    for (const state of this.turns.values()) {
      state.error = error;
      state.wake?.();
    }
  }

  private async nextFrame(state: TurnState): Promise<EngineFrame> {
    while (state.frames.length === 0 && !state.error && !state.aborted) {
      await new Promise<void>((resolve) => {
        state.wake = resolve;
      });
      state.wake = undefined;
    }
    if (state.error) {
      throw state.error;
    }
    if (state.aborted) {
      throw Object.assign(new Error("AO Reach request cancelled."), {
        name: "AbortError",
      });
    }
    return state.frames.shift()!;
  }

  private sendCancel(socket: WebSocket, questionId: string): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "cancel",
          questionId,
        }),
      );
    }
  }

  private isAuthError(error: unknown): boolean {
    return (
      error instanceof Error &&
      (error.message.includes("auth failed") ||
        /\bHTTP 4\d\d\b/.test(error.message))
    );
  }

  private authError(): Error {
    return new Error(
      "AO Reach auth failed. Check your apiKey / AO_REACH_TOKEN and identity headers.",
    );
  }

  private connectionError(error: unknown): Error {
    if (this.isAuthError(error)) {
      return this.authError();
    }
    return new Error(
      `AO Reach endpoint unreachable at ${this.baseUrl}. Is the agentic-orchestration daemon running with /ws?`,
      { cause: error },
    );
  }

  protected async *_streamChat(
    messages: ChatMessage[],
    signal: AbortSignal,
    _options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    if (signal.aborted) {
      return;
    }

    const socket = await this.ensureConnection();
    const questionId = uuidv4();
    const startedAt = Date.now();
    const state: TurnState = { frames: [], assistantBuffer: "" };
    let aborted = false;

    this.turns.set(questionId, state);
    const cancel = () => {
      aborted = true;
      state.aborted = true;
      this.sendCancel(socket, questionId);
      state.wake?.();
    };
    signal.addEventListener("abort", cancel, { once: true });

    const timeout = setTimeout(() => {
      this.sendCancel(socket, questionId);
      state.error = new Error(
        `Orchestration timed out after ${this.timeoutSeconds}s. Consider raising timeoutSeconds or switching to a faster overlay.`,
      );
      state.wake?.();
    }, this.timeoutSeconds * 1000);

    Logger.debug("AO Reach turn start", {
      questionId,
      sessionId: this.sessionId,
      sessionOverlay: this.sessionOverlay,
    });

    try {
      socket.send(
        JSON.stringify({
          type: "chat",
          text: this.formatMessages(messages),
          questionId,
          runMode: "dynamic",
          appId: APP_ID,
          selectedAgentProviderIds: this.packed?.agentIds ?? [],
          tokenId: this.apiKey,
        }),
      );

      while (!aborted) {
        const frame = await this.nextFrame(state);
        const type = String(frame.type || "");

        if (type === "chunk") {
          const stream = String(frame.stream || "stdout");
          const text = String(frame.text || "");
          if (!text) {
            continue;
          }
          if (stream === "thought") {
            yield { role: "thinking", content: text };
            continue;
          }
          if (stream === "stdout") {
            if (this.streamingEnabled) {
              yield { role: "assistant", content: text };
            } else {
              state.assistantBuffer += text;
            }
            continue;
          }
          // stderr / unknown: log only
          Logger.debug("AO Reach progress chunk", {
            stream,
            preview: text.slice(0, 120),
          });
          continue;
        }

        if (type === "status") {
          const phase = String(frame.phase || "");
          if (phase === "error" || phase === "cancelled") {
            const code = String(frame.code || phase);
            if (code === "cancelled" || phase === "cancelled") {
              return;
            }
            throw new Error(
              `AO Reach orchestration error: ${String(frame.message || code)}`,
            );
          }
          continue;
        }

        if (type === "run_end") {
          const ok = frame.ok !== false;
          const code = String(frame.code || "");
          if (!ok) {
            if (code === "cancelled") {
              return;
            }
            throw new Error(
              `AO Reach run failed: ${String(frame.error || frame.message || code || "unknown")}`,
            );
          }
          if (!this.streamingEnabled && state.assistantBuffer) {
            yield { role: "assistant", content: state.assistantBuffer };
          }
          return;
        }

        if (type === "error") {
          throw new Error(
            `AO Reach orchestration error: ${String(frame.message || "unknown error")}`,
          );
        }
      }
    } catch (error) {
      if (aborted || (error as Error)?.name === "AbortError") {
        return;
      }
      Logger.error(error, {
        provider: AOReach.providerName,
        questionId,
        sessionId: this.sessionId,
      });
      throw error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      this.turns.delete(questionId);
      Logger.debug("AO Reach turn end", {
        questionId,
        latencyMs: Date.now() - startedAt,
        aborted,
      });
    }
  }

  protected async *_streamComplete(
    prompt: string,
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<string> {
    for await (const message of this._streamChat(
      [{ role: "user", content: prompt }],
      signal,
      options,
    )) {
      if (message.role === "assistant") {
        yield renderChatMessage(message);
      }
    }
  }

  async listModels(): Promise<string[]> {
    return [this.sessionOverlay];
  }
}

export default AOReach;
