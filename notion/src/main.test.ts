import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { trackedMarkdownFiles } from "./main.js";

const execFileAsync = promisify(execFile);

test("trackedMarkdownFiles scopes candidates to the repository base path", async (t) => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "notion-action-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await mkdir(path.join(repositoryRoot, "contributing"));
  await mkdir(path.join(repositoryRoot, "infra"));
  await writeFile(path.join(repositoryRoot, "contributing", "guide.md"), "# Guide\n");
  await writeFile(path.join(repositoryRoot, "infra", "guide.md"), "# Guide\n");
  await execFileAsync("git", ["-C", repositoryRoot, "init"]);
  await execFileAsync("git", ["-C", repositoryRoot, "add", "."]);

  assert.deepEqual(await trackedMarkdownFiles(repositoryRoot, "contributing"), [
    "contributing/guide.md",
  ]);
});
