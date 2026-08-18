/**
 * Copyright 2023-2026 Continue Dev, Inc.
 * Licensed under the Apache License, Version 2.0.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import { parse as parseYaml } from "yaml";

export interface PackedOverlay {
  agents: Record<string, unknown>[];
  skills: Record<string, unknown>[];
  mcps: Record<string, unknown>[];
  agentIds: string[];
}

export function overlayAllowlists(packed: PackedOverlay): {
  allowedMcpProviderIds: string[];
  allowedSkillIds: string[];
} {
  const mcp = new Set<string>();
  for (const entry of packed.mcps) {
    const id = String(entry.id || "").trim();
    if (id) {
      mcp.add(id);
    }
  }
  for (const agent of packed.agents) {
    const list = agent.mcp_providers;
    if (Array.isArray(list)) {
      for (const item of list) {
        const id = String(item || "").trim();
        if (id) {
          mcp.add(id);
        }
      }
    }
  }
  const skills = packed.skills
    .map((entry) => String(entry.id || "").trim())
    .filter(Boolean);
  return {
    allowedMcpProviderIds: [...mcp],
    allowedSkillIds: skills,
  };
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

function expandUserPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("~/") || trimmed === "~") {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function loadYamlFile(filePath: string): Record<string, unknown> {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid overlay YAML object in ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

function loadYamlDir(dir: string): Record<string, unknown>[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort()
    .map((name) => loadYamlFile(path.join(dir, name)));
}

function normalizeAgent(
  raw: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const bareId = String(raw.id || "").trim();
  if (!bareId) {
    throw new Error(`Agent YAML under ${label} is missing required id.`);
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
}

function packSkills(packDir: string, label: string): Record<string, unknown>[] {
  return loadYamlDir(path.join(packDir, "agent_skills")).map((raw) => {
    const bareId = String(raw.id || "").trim();
    if (!bareId) {
      throw new Error(`Skill YAML under ${label} is missing required id.`);
    }
    return { ...raw, id: toClientId(bareId) };
  });
}

function withFilesystemMcp(
  include: boolean | undefined,
  agents: Record<string, unknown>[],
  skills: Record<string, unknown>[],
): PackedOverlay {
  const mcps: Record<string, unknown>[] = [];
  if (include !== false) {
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

function packOverlayDirectory(
  packDir: string,
  label: string,
  includeFilesystemMcp?: boolean,
): PackedOverlay {
  const agents = loadYamlDir(path.join(packDir, "agent_providers")).map((raw) =>
    normalizeAgent(raw, label),
  );
  if (agents.length === 0) {
    const loose = fs
      .readdirSync(packDir)
      .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
      .sort()
      .map((name) =>
        normalizeAgent(loadYamlFile(path.join(packDir, name)), label),
      );
    if (loose.length === 0) {
      throw new Error(
        `AO Reach overlay "${label}" has no agent YAML (expected agent_providers/*.yaml or *.yaml in the folder).`,
      );
    }
    return withFilesystemMcp(
      includeFilesystemMcp,
      loose,
      packSkills(packDir, label),
    );
  }
  return withFilesystemMcp(
    includeFilesystemMcp,
    agents,
    packSkills(packDir, label),
  );
}

/**
 * Pack an overlay from an explicit path: a single agent YAML file, an overlay
 * folder (`agent_providers/`), or a folder of YAML files.
 */
export function packAgentDefinition(
  definitionPath: string,
  options?: { includeFilesystemMcp?: boolean },
): PackedOverlay {
  const resolved = path.resolve(expandUserPath(definitionPath));
  if (!fs.existsSync(resolved)) {
    throw new Error(`AO Reach agentDefinition not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    const label = path.basename(resolved);
    const agent = normalizeAgent(loadYamlFile(resolved), label);
    const parent = path.dirname(resolved);
    const packDir =
      path.basename(parent) === "agent_providers"
        ? path.dirname(parent)
        : parent;
    return withFilesystemMcp(
      options?.includeFilesystemMcp,
      [agent],
      packSkills(packDir, label),
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `AO Reach agentDefinition is not a file or folder: ${resolved}`,
    );
  }
  return packOverlayDirectory(
    resolved,
    resolved,
    options?.includeFilesystemMcp,
  );
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
    // Packaged extension: bundle is <extensionRoot>/out/extension.js and the
    // overlay packs ship at <extensionRoot>/overlays (moduleDir/../overlays).
    path.resolve(moduleDir, "../overlays"),
    path.resolve(moduleDir, "overlays"),
    // Other packaged layouts / nesting depths.
    path.resolve(moduleDir, "../../overlays"),
    path.resolve(moduleDir, "../../../overlays"),
    path.resolve(moduleDir, "../../../../overlays"),
    // Dev: run from repo/workspace roots.
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
  return packOverlayDirectory(
    packDir,
    sessionOverlay,
    options?.includeFilesystemMcp,
  );
}
