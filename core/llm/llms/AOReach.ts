/**
 * Copyright 2023-2026 Continue Dev, Inc.
 * Licensed under the Apache License, Version 2.0.
 */

import { v4 as uuidv4 } from "uuid";
import WebSocket, { RawData } from "ws";
import path from "path";

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
import {
  overlayAllowlists,
  packAgentDefinition,
  packSessionOverlay,
  PackedOverlay,
} from "./aoReachOverlay.js";

const APP_ID = "continue-comstar";
const OVERLAY_TTL_SECONDS = 3600;

type EngineFrame = Record<string, unknown>;

/**
 * Idle (not wall-clock) budget: a run is only abandoned after this much silence
 * from AO. The engine heartbeats every ~10s while working, so orchestrations
 * that legitimately take many minutes are never cut short. Set 0 to disable.
 */
/** 0 = wait indefinitely; set a positive value to abort after that many seconds of silence from AO. */
const DEFAULT_IDLE_TIMEOUT_SECONDS = 0;

interface AOReachOptions extends LLMOptions {
  baseUrl: string;
  sessionOverlay?: string;
  /** Path to an agent YAML file or overlay folder (takes precedence over sessionOverlay). */
  agentDefinition?: string;
  sessionId?: string;
  /** Seconds of silence from AO before giving up (0 disables). */
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
  /** Re-arms the idle watchdog; AO liveness is measured from the last frame. */
  onActivity?: () => void;
  lastProgressLine?: string;
}

class AOReach extends BaseLLM {
  static providerName = "ao_reach";
  static defaultOptions: Partial<LLMOptions> = {
    model: "ao_reach",
  };

  readonly baseUrl: string;
  readonly sessionOverlay: string;
  readonly agentDefinition?: string;
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
  private overlayAcked = false;
  private overlayWait?: TurnState;

  constructor(options: LLMOptions) {
    super(options);
    // Continue autodetects ChatML for unknown model names (including "ao_reach").
    // That routes streamChat through _streamComplete, which drops thinking chunks.
    this.templateMessages = undefined;

    const aoOptions = options as AOReachOptions;
    this.baseUrl = (aoOptions.baseUrl || aoOptions.apiBase || "").replace(
      /\/+$/,
      "",
    );
    this.agentDefinition = aoOptions.agentDefinition?.trim() || undefined;
    this.sessionOverlay =
      aoOptions.sessionOverlay ||
      (this.agentDefinition
        ? path.basename(
            this.agentDefinition,
            path.extname(this.agentDefinition),
          )
        : "");
    this.timeoutSeconds =
      aoOptions.timeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
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
    if (!this.agentDefinition && !this.sessionOverlay) {
      throw new Error(
        "AO Reach requires agentDefinition (path to agent YAML or overlay folder) or sessionOverlay (shipped pack name) in config.yaml.",
      );
    }
    if (!Number.isFinite(this.timeoutSeconds) || this.timeoutSeconds < 0) {
      throw new Error(
        "AO Reach timeoutSeconds must be zero (no idle timeout) or greater.",
      );
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
    const assembled = messages
      .map((message) => `<${message.role}>\n${renderChatMessage(message)}`)
      .join("\n");
    const capRaw = Number(process.env.AO_REACH_PROMPT_CHARS || "12000");
    const cap = Number.isFinite(capRaw)
      ? Math.max(2000, Math.min(100000, capRaw))
      : 12000;
    if (assembled.length <= cap) {
      return assembled;
    }
    const last = messages[messages.length - 1];
    const lastBlock =
      last !== undefined
        ? `<${last.role}>\n${renderChatMessage(last)}`
        : assembled.slice(-Math.floor(cap / 2));
    const budget = Math.max(500, cap - lastBlock.length - 40);
    const head = assembled.slice(0, assembled.length - lastBlock.length);
    return `…[truncated earlier context]\n${head.slice(-budget)}\n${lastBlock}`;
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
        Logger.warn("AO Reach connect attempt failed", {
          attempt: attempt + 1,
          baseUrl: this.baseUrl,
          error: error instanceof Error ? error.message : String(error),
          cause:
            error instanceof Error && error.cause instanceof Error
              ? error.cause.message
              : undefined,
        });
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
          this.overlayAcked = false;
          this.overlayWait = undefined;
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

    const overlayWait = this.overlayWait;
    if (overlayWait && !overlayWait.aborted) {
      const overlayType = String(frame.type || "");
      if (
        overlayType === "session_overlay_ack" ||
        overlayType === "session_overlay_denied" ||
        overlayType === "error" ||
        overlayType === "status" ||
        overlayType === "chunk"
      ) {
        overlayWait.onActivity?.();
        overlayWait.frames.push(frame);
        overlayWait.wake?.();
        if (
          overlayType === "session_overlay_ack" ||
          overlayType === "session_overlay_denied" ||
          overlayType === "error"
        ) {
          // Terminal overlay frames also fall through for logging below.
        } else {
          return;
        }
      }
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
    state.onActivity?.();

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

  private loadPackedOverlay(): PackedOverlay {
    if (this.agentDefinition) {
      return packAgentDefinition(this.agentDefinition, {
        includeFilesystemMcp: this.filesystemTunnel,
      });
    }
    return packSessionOverlay(this.sessionOverlay, {
      overlayRoot: this.overlayRoot,
      includeFilesystemMcp: this.filesystemTunnel,
    });
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

    this.packed = this.loadPackedOverlay();
  }

  private async registerOverlay(
    socket: WebSocket,
    opts?: { force?: boolean },
  ): Promise<void> {
    for await (const _chunk of this.registerOverlayStreaming(
      socket,
      undefined,
      opts,
    )) {
      void _chunk;
    }
  }

  private async *registerOverlayStreaming(
    socket: WebSocket,
    signal?: AbortSignal,
    opts?: { force?: boolean },
  ): AsyncGenerator<ChatMessage> {
    if (this.overlayAcked && !opts?.force) {
      return;
    }
    if (!this.packed) {
      throw new Error("AO Reach overlay pack missing.");
    }

    const state: TurnState = { frames: [], assistantBuffer: "" };
    this.overlayWait = state;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdleTimer = () => {
      if (this.timeoutSeconds <= 0) {
        return;
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        state.error = new Error(
          `Timed out waiting for session_overlay_ack from agentic-orchestration (${this.timeoutSeconds}s of silence).`,
        );
        state.wake?.();
      }, this.timeoutSeconds * 1000);
    };
    state.onActivity = armIdleTimer;
    armIdleTimer();

    const onAbort = () => {
      state.aborted = true;
      this.sendCancel(socket, "", { target: "overlay" });
      state.wake?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const allow = overlayAllowlists(this.packed);
      const register: Record<string, unknown> = {
        type: "session_overlay_register",
        appId: APP_ID,
        ttlSeconds: OVERLAY_TTL_SECONDS,
        agents: this.packed.agents,
        skills: this.packed.skills,
        mcps: this.packed.mcps,
        allowedAgentProviderIds: [],
        allowedMcpProviderIds: allow.allowedMcpProviderIds,
      };
      if (allow.allowedSkillIds.length > 0) {
        register.allowedSkillIds = allow.allowedSkillIds;
      }
      socket.send(JSON.stringify(register));

      while (!state.aborted) {
        const frame = await this.nextFrame(state);
        const type = String(frame.type || "");
        if (type === "session_overlay_ack") {
          this.overlayAcked = true;
          this.scheduleOverlayRefresh();
          Logger.debug("AO Reach connection ready", {
            baseUrl: this.baseUrl,
            sessionId: this.sessionId,
            sessionOverlay: this.sessionOverlay,
            agentIds: this.packed.agentIds,
          });
          return;
        }
        if (type === "session_overlay_denied" || type === "error") {
          throw new Error(
            `AO Reach session overlay registration failed: ${String(frame.message || frame.error || type)}`,
          );
        }
        if (type === "status") {
          const phase = String(frame.phase || "");
          if (phase === "cancelled") {
            throw Object.assign(new Error("AO Reach request cancelled."), {
              name: "AbortError",
            });
          }
          const progress = this.progressLine(frame, state);
          if (progress) {
            yield { role: "thinking", content: progress };
          }
          continue;
        }
        if (type === "chunk") {
          const stream = String(frame.stream || "");
          const text = String(frame.text || "");
          if (stream === "thought" && text) {
            yield {
              role: "thinking",
              content: text.endsWith("\n") ? text : `${text}\n`,
            };
            continue;
          }
          if ((stream === "stderr" || !stream) && text) {
            const stripped = text.replace(/^\(engine\)\s*/i, "").trim();
            if (stripped && stripped !== state.lastProgressLine) {
              state.lastProgressLine = stripped;
              yield { role: "thinking", content: `${stripped}\n` };
            }
          }
        }
      }
      throw Object.assign(new Error("AO Reach request cancelled."), {
        name: "AbortError",
      });
    } finally {
      clearTimeout(idleTimer);
      signal?.removeEventListener("abort", onAbort);
      if (this.overlayWait === state) {
        this.overlayWait = undefined;
      }
    }
  }

  private scheduleOverlayRefresh(): void {
    this.clearOverlayRefresh();
    const refreshMs = Math.max(60_000, OVERLAY_TTL_SECONDS * 1000 * 0.8);
    this.overlayRefreshTimer = setTimeout(() => {
      void (async () => {
        try {
          this.packed = this.loadPackedOverlay();
          const socket = await this.ensureConnection();
          await this.registerOverlay(socket, { force: true });
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

  private sendCancel(
    socket: WebSocket,
    questionId: string,
    extra?: { target?: string },
  ): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "cancel",
          ...(questionId ? { questionId } : {}),
          ...(extra?.target ? { target: extra.target } : {}),
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
    const detail =
      error instanceof Error
        ? error.message
        : error
          ? String(error)
          : "unknown error";
    return new Error(
      `AO Reach endpoint unreachable at ${this.baseUrl}. Underlying error: ${detail}`,
      { cause: error },
    );
  }

  /**
   * Render an AO `status` frame as a progress line for the thinking pane.
   * Returns undefined for phases with nothing new to say, so the pane shows
   * what the orchestration is doing without repeating itself.
   */
  private progressLine(
    frame: EngineFrame,
    state: TurnState,
  ): string | undefined {
    const phase = String(frame.phase || "");
    if (phase === "done") {
      return undefined;
    }
    const message = String(frame.message || "").trim();
    if (!message) {
      return undefined;
    }
    const step = frame.step as number | undefined;
    const stepCount = frame.stepCount as number | undefined;
    const prefix =
      typeof step === "number" && typeof stepCount === "number"
        ? `[${step}/${stepCount}] `
        : "";
    const line = `${prefix}${message}`;
    if (line === state.lastProgressLine) {
      return undefined;
    }
    state.lastProgressLine = line;
    return `${line}\n`;
  }

  protected async *_streamChat(
    messages: ChatMessage[],
    signal: AbortSignal,
    _options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    if (signal.aborted) {
      return;
    }

    yield { role: "thinking", content: "Preparing AO session…\n" };

    const socket = await this.ensureConnection();
    const questionId = uuidv4();
    const startedAt = Date.now();
    const state: TurnState = { frames: [], assistantBuffer: "" };
    let aborted = false;

    this.turns.set(questionId, state);
    const cancel = () => {
      aborted = true;
      state.aborted = true;
      if (this.overlayWait) {
        this.overlayWait.aborted = true;
        this.overlayWait.wake?.();
        this.sendCancel(socket, questionId, { target: "overlay" });
      } else {
        this.sendCancel(socket, questionId);
      }
      state.wake?.();
    };
    signal.addEventListener("abort", cancel, { once: true });

    // Watchdog on silence, not on total run time: any frame from AO (progress,
    // thought, token, heartbeat) re-arms it, so long orchestrations keep running.
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdleTimer = () => {
      if (this.timeoutSeconds <= 0) {
        return;
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        this.sendCancel(socket, questionId);
        state.error = new Error(
          `AO Reach stopped reporting progress for ${this.timeoutSeconds}s. The engine may have died mid-run — check the engine logs, or set timeoutSeconds: 0 to wait indefinitely.`,
        );
        state.wake?.();
      }, this.timeoutSeconds * 1000);
    };
    state.onActivity = armIdleTimer;
    armIdleTimer();

    Logger.debug("AO Reach turn start", {
      questionId,
      sessionId: this.sessionId,
      sessionOverlay: this.sessionOverlay,
    });

    try {
      yield* this.registerOverlayStreaming(socket, signal);
      if (aborted || signal.aborted) {
        return;
      }
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
          const progress = this.progressLine(frame, state);
          if (progress) {
            yield { role: "thinking", content: progress };
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
      clearTimeout(idleTimer);
      state.onActivity = undefined;
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
