import assert from "node:assert/strict";
import test from "node:test";

import { parseDocument } from "./document.js";

test("parseDocument selects marked Markdown and removes its first H1", () => {
  const source = `---
notion:
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
    repositoryBasePath: "",
    owners: ["andreas"],
    tags: ["Architecture", "API"],
    title: "Authentication",
    body: "```markdown\n# Example\n```\n\n\nThis document explains authentication.\n",
  });
});
