import assert from "node:assert/strict";
import test from "node:test";

import { parseActionConfig } from "./config.js";

test("parseActionConfig normalizes the root ID and repository base path", () => {
  assert.deepEqual(
    parseActionConfig("3ee512d6-43f3-8063-b525-d6c3619c1f69", "./contributing/"),
    {
      rootPageID: "3ee512d643f38063b525d6c3619c1f69",
      repositoryBasePath: "contributing",
    },
  );
});
