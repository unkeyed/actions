import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import * as core from "@actions/core";

import { parseRootRegistry } from "./config.js";
import { parseDocument } from "./document.js";
import { WikiClient } from "./notion.js";
import { type Document, syncDocumentsForRoots } from "./sync.js";

const execFileAsync = promisify(execFile);

/** run discovers marked sources and synchronizes every configured wiki. */
export async function run(): Promise<void> {
  const token = process.env.NOTION_TOKEN?.trim();
  if (!token) {
    throw new Error("Notion token is required");
  }
  const repositoryRoot = await findRepositoryRoot();
  const configuredPath = core.getInput("config").trim() || ".github/notion.yaml";
  const registryPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(repositoryRoot, configuredPath);
  const roots = parseRootRegistry(await readFile(registryPath, "utf8"));
  const rootByID = new Map(roots.map((root) => [root.pageID, root]));
  const documents: Document[] = [];

  for (const sourcePath of await trackedMarkdownFiles(repositoryRoot)) {
    const document = parseDocument(
      sourcePath,
      await readFile(path.join(repositoryRoot, sourcePath), "utf8"),
    );
    if (!document) {
      continue;
    }
    const root = rootByID.get(document.rootPageID);
    if (root) {
      document.sourceDirectory = root.sourceDirectory;
    }
    documents.push(document);
  }

  const notion = new WikiClient(token);
  await syncDocumentsForRoots(
    notion,
    documents,
    roots.map((root) => root.pageID),
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

async function trackedMarkdownFiles(repositoryRoot: string): Promise<string[]> {
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
  return stdout.split("\0").filter((sourcePath) => sourcePath !== "");
}
