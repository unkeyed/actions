import assert from "node:assert/strict";
import test from "node:test";

import { parseRootRegistry } from "./config.js";

test("parseRootRegistry normalizes wiki IDs and source directories", () => {
  assert.deepEqual(
    parseRootRegistry(`roots:
  - pageID: 3ee512d6-43f3-8063-b525-d6c3619c1f69
    sourceDirectory: ./contributing/
`),
    [
      {
        pageID: "3ee512d643f38063b525d6c3619c1f69",
        sourceDirectory: "contributing",
      },
    ],
  );
});
