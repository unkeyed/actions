import assert from "node:assert/strict";
import test from "node:test";

import { parseDocument } from "./document.js";

test("parseDocument selects marked Markdown and removes its first H1", () => {
  const source = `---
notion:
  rootPageID: 195de922-1179-449f-ab80-75a27c979105
  owners: [Andreas]
  tags:
    - " Architecture "
    - API
---

\`\`\`markdown
# Example
\`\`\`

# Authentication

This document explains authentication.
`;

  assert.deepEqual(parseDocument("svc/api/authentication.mdx", source), {
    sourcePath: "svc/api/authentication.mdx",
    sourceDirectory: "",
    rootPageID: "195de9221179449fab8075a27c979105",
    owners: ["andreas"],
    tags: ["Architecture", "API"],
    title: "Authentication",
    body: "```markdown\n# Example\n```\n\n\nThis document explains authentication.\n",
  });
});
