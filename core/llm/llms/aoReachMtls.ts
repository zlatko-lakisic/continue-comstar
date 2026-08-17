/**
 * Copyright 2023-2026 Continue Dev, Inc.
 * Licensed under the Apache License, Version 2.0.
 */

import fs from "fs";
import os from "os";
import path from "path";

export interface ReachMtlsMaterial {
  cert: string;
  key: string;
  ca: string;
  materialDir: string;
}

function expandHome(input: string): string {
  if (input.startsWith("~/") || input === "~") {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/**
 * Load Reach-compatible mTLS material from a directory containing
 * cert.pem, key.pem, and ca.pem.
 */
export function loadReachMtlsMaterial(materialDir: string): ReachMtlsMaterial {
  const root = path.resolve(expandHome(materialDir.trim()));
  const certPath = path.join(root, "cert.pem");
  const keyPath = path.join(root, "key.pem");
  const caPath = path.join(root, "ca.pem");

  for (const filePath of [certPath, keyPath, caPath]) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(
        `AO Reach mTLS material missing: ${filePath}. Enroll a client cert and set mtlsMaterialDir / AO_REACH_MTLS_DIR.`,
      );
    }
  }

  return {
    cert: fs.readFileSync(certPath, "utf8"),
    key: fs.readFileSync(keyPath, "utf8"),
    ca: fs.readFileSync(caPath, "utf8"),
    materialDir: root,
  };
}

export function assertMtlsUsesTls(baseUrl: string): void {
  const lower = baseUrl.trim().toLowerCase();
  if (!lower.startsWith("https://") && !lower.startsWith("wss://")) {
    throw new Error(
      `AO Reach mTLS requires an https:// or wss:// baseUrl, got: ${baseUrl}`,
    );
  }
}

export function resolveMtlsMaterialDir(
  configured?: string,
): string | undefined {
  const fromConfig = configured?.trim();
  if (fromConfig) {
    return fromConfig;
  }
  const fromEnv = process.env.AO_REACH_MTLS_DIR?.trim();
  return fromEnv || undefined;
}
