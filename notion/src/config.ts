import path from "node:path";

/** ActionConfig identifies the one wiki and repository hierarchy managed by a run. */
export interface ActionConfig {
  rootPageID: string;
  repositoryBasePath: string;
}

/** parseActionConfig validates action inputs before repository discovery. */
export function parseActionConfig(
  configuredID: string,
  configuredBasePath: string,
): ActionConfig {
  const pageID = configuredID.trim().replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(pageID)) {
    throw new Error("root-page-id must contain 32 hexadecimal characters");
  }
  const normalizedPath = path.posix.normalize(configuredBasePath.trim() || ".");
  const repositoryBasePath =
    normalizedPath === "." ? normalizedPath : normalizedPath.replace(/\/$/, "");
  if (path.posix.isAbsolute(repositoryBasePath) || repositoryBasePath.startsWith("../")) {
    throw new Error(
      `repository-base-path ${JSON.stringify(configuredBasePath)} must be repository-relative`,
    );
  }
  return { rootPageID: pageID, repositoryBasePath };
}
