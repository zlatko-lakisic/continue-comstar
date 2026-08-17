/**
 * Copyright 2023-2026 Continue Dev, Inc.
 * Licensed under the Apache License, Version 2.0.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { parse as parseYaml } from "yaml";

export interface PackedOverlay {
  agents: Record<string, unknown>[];
  skills: Record<string, unknown>[];
  mcps: Record<string, unknown>[];
  agentIds: string[];
}

function toClientId(bareId: string): string {
  const id = bareId.trim();
  if (!id) {
    return id;
  }
  return id.startsWith("client.") ? id : `client.${id}`;
}

function rewriteMcpProviders(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((entry) => {
    if (typeof entry === "string") {
      return toClientId(entry);
    }
    return String(entry);
  });
}

function loadYamlDir(dir: string): Record<string, unknown>[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort()
    .map((name) => {
      const raw = fs.readFileSync(path.join(dir, name), "utf8");
      const parsed = parseYaml(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Invalid overlay YAML object in ${name}`);
      }
      return parsed as Record<string, unknown>;
    });
}

/**
 * Resolve the overlays root directory.
 * Priority: AO_REACH_OVERLAY_ROOT → extension overlays/ → repo overlays/.
 */
export function resolveOverlayRoot(explicitRoot?: string): string {
  if (explicitRoot?.trim()) {
    return path.resolve(explicitRoot.trim());
  }
  if (process.env.AO_REACH_OVERLAY_ROOT?.trim()) {
    return path.resolve(process.env.AO_REACH_OVERLAY_ROOT.trim());
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Packaged extension: extensions/vscode/overlays
    path.resolve(moduleDir, "../../../../overlays"),
    path.resolve(moduleDir, "../../../overlays"),
    path.resolve(moduleDir, "../../overlays"),
    // Dev: core/llm/llms → repo root overlays
    path.resolve(moduleDir, "../../../../overlays"),
    path.resolve(process.cwd(), "overlays"),
    path.resolve(process.cwd(), "../overlays"),
    path.resolve(process.cwd(), "../../overlays"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  throw new Error(
    `AO Reach overlay root not found. Set AO_REACH_OVERLAY_ROOT or ship overlays/ next to the extension.`,
  );
}

export function packSessionOverlay(
  sessionOverlay: string,
  options?: {
    overlayRoot?: string;
    includeFilesystemMcp?: boolean;
  },
): PackedOverlay {
  const root = resolveOverlayRoot(options?.overlayRoot);
  const packDir = path.join(root, sessionOverlay);
  if (!fs.existsSync(packDir) || !fs.statSync(packDir).isDirectory()) {
    throw new Error(
      `AO Reach session overlay "${sessionOverlay}" not found under ${root}.`,
    );
  }

  const agents = loadYamlDir(path.join(packDir, "agent_providers")).map(
    (raw) => {
      const bareId = String(raw.id || "").trim();
      if (!bareId) {
        throw new Error(
          `Agent YAML under ${sessionOverlay} is missing required id.`,
        );
      }
      const out: Record<string, unknown> = { ...raw, id: toClientId(bareId) };
      if (String(out.type || "").toLowerCase() === "ollama") {
        delete out.ollama_host;
        out.selfcontained = false;
      }
      const mcpProviders = rewriteMcpProviders(out.mcp_providers);
      if (mcpProviders) {
        out.mcp_providers = mcpProviders;
      }
      return out;
    },
  );

  if (agents.length === 0) {
    throw new Error(
      `AO Reach session overlay "${sessionOverlay}" has no agent_providers/*.yaml.`,
    );
  }

  const skills = loadYamlDir(path.join(packDir, "agent_skills")).map((raw) => {
    const bareId = String(raw.id || "").trim();
    if (!bareId) {
      throw new Error(
        `Skill YAML under ${sessionOverlay} is missing required id.`,
      );
    }
    return { ...raw, id: toClientId(bareId) };
  });

  const mcps: Record<string, unknown>[] = [];
  if (options?.includeFilesystemMcp !== false) {
    mcps.push({
      id: "client.filesystem_local",
      description: "VS Code workspace (session tunnel)",
      streamable_http: {
        url: "tunnel://session-mcp/filesystem",
        headers: {},
      },
    });
  }

  return {
    agents,
    skills,
    mcps,
    agentIds: agents.map((agent) => String(agent.id)),
  };
}
