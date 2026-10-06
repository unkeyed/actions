import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import * as core from "@actions/core";

import { parseActionConfig } from "./config.js";
import { parseDocument } from "./document.js";
import { WikiClient } from "./notion.js";
import { type Document, syncDocuments } from "./sync.js";

const execFileAsync = promisify(execFile);

/** run discovers marked sources and synchronizes the configured wiki. */
export async function run(): Promise<void> {
  const token = process.env.NOTION_TOKEN?.trim();
  if (!token) {
    throw new Error("Notion token is required");
  }
  const config = parseActionConfig(
    core.getInput("root-page-id"),
    core.getInput("repository-base-path"),
  );
  const repositoryRoot = await findRepositoryRoot();
  const documents: Document[] = [];

  for (const sourcePath of await trackedMarkdownFiles(
    repositoryRoot,
    config.repositoryBasePath,
  )) {
    const document = parseDocument(
      sourcePath,
      await readFile(path.join(repositoryRoot, sourcePath), "utf8"),
    );
    if (!document) {
      continue;
    }
    document.repositoryBasePath = config.repositoryBasePath;
    documents.push(document);
  }

  const notion = new WikiClient(token);
  await syncDocuments(
    notion,
    documents,
    config.rootPageID,
    (document) => core.info(`Synced ${document.sourcePath} as ${JSON.stringify(document.title)}.`),
  );
  core.info(`Synced ${documents.length} Notion documents.`);
}

async function findRepositoryRoot(): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", "safe.directory=*", "rev-parse", "--show-toplevel"],
    { encoding: "utf8" },
  );
  return stdout.trim();
}

/** trackedMarkdownFiles returns marked-file candidates below one repository base path. */
export async function trackedMarkdownFiles(
  repositoryRoot: string,
  repositoryBasePath: string,
): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c",
      "safe.directory=*",
      "-C",
      repositoryRoot,
      "ls-files",
      "-z",
      "--",
      "*.md",
      "*.mdx",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout
    .split("\0")
    .filter(
      (sourcePath) =>
        sourcePath !== "" &&
        (repositoryBasePath === "." || sourcePath.startsWith(`${repositoryBasePath}/`)),
    );
}
