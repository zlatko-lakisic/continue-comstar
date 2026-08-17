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

type AOReachResponseFrame =
  | { type: "delta"; turnId: string; content: string }
  | { type: "done"; turnId: string; content?: string }
  | { type: "error"; turnId: string; message: string };

interface AOReachOptions extends LLMOptions {
  baseUrl: string;
  sessionOverlay: string;
  sessionId?: string;
  timeoutSeconds?: number;
  streamingEnabled?: boolean;
  workspaceName?: string;
}

interface TurnState {
  frames: AOReachResponseFrame[];
  wake?: () => void;
  error?: Error;
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
  private socket?: WebSocket;
  private connectionPromise?: Promise<WebSocket>;
  private readonly turns = new Map<string, TurnState>();

  constructor(options: LLMOptions) {
    super(options);

    const aoOptions = options as AOReachOptions;
    this.baseUrl = aoOptions.baseUrl?.replace(/\/+$/, "");
    this.sessionOverlay = aoOptions.sessionOverlay;
    this.timeoutSeconds = aoOptions.timeoutSeconds ?? 15;
    this.streamingEnabled = aoOptions.streamingEnabled ?? true;
    this.apiKey = this.resolveApiKey(aoOptions.apiKey);
    this.sessionId =
      aoOptions.sessionId ??
      `continue-comstar-${aoOptions.workspaceName || "workspace"}`;

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

  private getSessionUrl(): string {
    let url: URL;
    try {
      url = new URL(this.baseUrl);
    } catch {
      throw new Error(
        `Invalid AO Reach baseUrl "${this.baseUrl}". Expected a ws:// or wss:// URL.`,
      );
    }

    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Error(
        `Invalid AO Reach baseUrl "${this.baseUrl}". Expected a ws:// or wss:// URL.`,
      );
    }

    url.pathname = `${url.pathname.replace(/\/+$/, "")}/sessions/${encodeURIComponent(this.sessionId)}`;
    return url.toString();
  }

  private formatMessages(messages: ChatMessage[]): string {
    return messages
      .map((message) => `<${message.role}>\n${renderChatMessage(message)}`)
      .join("\n");
  }

  private async ensureConnection(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) {
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
    const sessionUrl = this.getSessionUrl();

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(sessionUrl, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "x-agentic-session-overlay": this.sessionOverlay,
          "x-agentic-session-id": this.sessionId,
        },
      });
      let settled = false;

      socket.once("unexpected-response", (_request, response) => {
        const statusCode = response.statusCode ?? 500;
        const error =
          statusCode >= 400 && statusCode < 500
            ? this.authError()
            : new Error(
                `AO Reach WebSocket upgrade failed with HTTP ${statusCode}.`,
              );
        response.resume();
        socket.terminate();
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      socket.once("open", () => {
        if (settled) {
          return;
        }
        settled = true;
        this.socket = socket;
        Logger.debug("AO Reach connection open", {
          baseUrl: this.baseUrl,
          sessionId: this.sessionId,
          sessionOverlay: this.sessionOverlay,
        });
        resolve(socket);
      });

      socket.on("message", (data) => this.handleMessage(data));
      socket.on("close", (code, reason) => {
        if (this.socket === socket) {
          this.socket = undefined;
        }
        Logger.debug("AO Reach connection closed", {
          code,
          reason: reason.toString(),
          sessionId: this.sessionId,
        });
        const error = new Error(
          "AO Reach connection closed before the response completed. The provider will reconnect on the next request.",
        );
        this.rejectAllTurns(error);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      socket.on("error", (error) => {
        if (settled) {
          Logger.error(error, {
            provider: AOReach.providerName,
            baseUrl: this.baseUrl,
          });
        } else {
          settled = true;
          reject(error);
        }
      });
    });
  }

  private handleMessage(data: RawData): void {
    let frame: AOReachResponseFrame;
    try {
      frame = JSON.parse(data.toString()) as AOReachResponseFrame;
    } catch (error) {
      const parseError = new Error(
        `AO Reach returned an invalid response frame: ${error instanceof Error ? error.message : String(error)}`,
      );
      Logger.error(parseError, { provider: AOReach.providerName });
      this.rejectAllTurns(parseError);
      return;
    }

    if (
      !frame ||
      !["delta", "done", "error"].includes(frame.type) ||
      typeof frame.turnId !== "string"
    ) {
      const protocolError = new Error(
        "AO Reach returned an unsupported response frame.",
      );
      Logger.error(protocolError, { provider: AOReach.providerName });
      this.rejectAllTurns(protocolError);
      return;
    }

    const state = this.turns.get(frame.turnId);
    if (!state) {
      Logger.warn("AO Reach returned a frame for an unknown turn", {
        turnId: frame.turnId,
        type: frame.type,
      });
      return;
    }

    if (frame.type === "error") {
      state.error = new Error(`AO Reach orchestration error: ${frame.message}`);
    } else {
      state.frames.push(frame);
    }
    state.wake?.();
  }

  private rejectAllTurns(error: Error): void {
    for (const state of this.turns.values()) {
      state.error = error;
      state.wake?.();
    }
  }

  private async nextFrame(state: TurnState): Promise<AOReachResponseFrame> {
    while (state.frames.length === 0 && !state.error) {
      await new Promise<void>((resolve) => {
        state.wake = resolve;
      });
      state.wake = undefined;
    }
    if (state.error) {
      throw state.error;
    }
    return state.frames.shift()!;
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
      "AO Reach auth failed. Check your apiKey / AO_REACH_TOKEN.",
    );
  }

  private connectionError(error: unknown): Error {
    if (this.isAuthError(error)) {
      return this.authError();
    }
    return new Error(
      `AO Reach endpoint unreachable at ${this.baseUrl}. Is the agentic-orchestration daemon running?`,
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
    const turnId = uuidv4();
    const startedAt = Date.now();
    const state: TurnState = { frames: [] };
    let aborted = false;
    let buffered = "";

    this.turns.set(turnId, state);
    const cancel = () => {
      aborted = true;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "cancel", turnId }));
      }
      state.error = Object.assign(new Error("AO Reach request cancelled."), {
        name: "AbortError",
      });
      state.wake?.();
    };
    signal.addEventListener("abort", cancel, { once: true });

    const timeout = setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "cancel", turnId }));
      }
      state.error = new Error(
        `Orchestration timed out after ${this.timeoutSeconds}s. Consider raising timeoutSeconds or switching to a faster overlay.`,
      );
      state.wake?.();
    }, this.timeoutSeconds * 1000);

    Logger.debug("AO Reach turn start", {
      turnId,
      sessionId: this.sessionId,
      sessionOverlay: this.sessionOverlay,
    });

    try {
      socket.send(
        JSON.stringify({
          type: "query",
          turnId,
          content: this.formatMessages(messages),
          options: { timeoutSeconds: this.timeoutSeconds },
        }),
      );

      while (!aborted) {
        const frame = await this.nextFrame(state);
        if (frame.type === "delta") {
          if (this.streamingEnabled) {
            yield { role: "assistant", content: frame.content };
          } else {
            buffered += frame.content;
          }
          continue;
        }
        if (frame.type === "error") {
          throw new Error(`AO Reach orchestration error: ${frame.message}`);
        }

        const finalContent = frame.content ?? "";
        if (this.streamingEnabled) {
          if (finalContent) {
            yield { role: "assistant", content: finalContent };
          }
        } else {
          buffered += finalContent;
          if (buffered) {
            yield { role: "assistant", content: buffered };
          }
        }
        return;
      }
    } catch (error) {
      if (aborted) {
        return;
      }
      Logger.error(error, {
        provider: AOReach.providerName,
        turnId,
        sessionId: this.sessionId,
      });
      throw error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      this.turns.delete(turnId);
      Logger.debug("AO Reach turn end", {
        turnId,
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
      yield renderChatMessage(message);
    }
  }

  async listModels(): Promise<string[]> {
    return [this.sessionOverlay];
  }
}

export default AOReach;
