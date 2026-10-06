import path from "node:path";

import { parse } from "yaml";

/** RootConfig identifies one wiki and its repository hierarchy root. */
export interface RootConfig {
  pageID: string;
  sourceDirectory: string;
}

/** parseRootRegistry validates the complete root registry before publication. */
export function parseRootRegistry(source: string): RootConfig[] {
  const value = parse(source) as unknown;
  if (!isRecord(value) || !Array.isArray(value.roots) || value.roots.length === 0) {
    throw new Error("Notion root registry has no roots");
  }
  const roots = value.roots.map(parseRoot);
  if (new Set(roots.map((root) => root.pageID)).size !== roots.length) {
    throw new Error("a Notion root is configured more than once");
  }
  return roots;
}

function parseRoot(value: unknown): RootConfig {
  if (!isRecord(value)) {
    throw new Error("Notion root must be a mapping");
  }
  const configuredID = typeof value.pageID === "string" ? value.pageID : "";
  const pageID = configuredID.trim().replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(pageID)) {
    throw new Error(`invalid Notion root ${JSON.stringify(configuredID)}`);
  }
  const configuredDirectory =
    typeof value.sourceDirectory === "string" ? value.sourceDirectory.trim() : ".";
  const normalizedDirectory = path.posix.normalize(configuredDirectory || ".");
  const sourceDirectory =
    normalizedDirectory === "." ? normalizedDirectory : normalizedDirectory.replace(/\/$/, "");
  if (path.posix.isAbsolute(sourceDirectory) || sourceDirectory.startsWith("../")) {
    throw new Error(`Notion source directory ${JSON.stringify(configuredDirectory)} must be repository-relative`);
  }
  return { pageID, sourceDirectory };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
