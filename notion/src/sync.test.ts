import assert from "node:assert/strict";
import test from "node:test";

import {
  type Document,
  type NotionAPI,
  type Page,
  syncDocuments,
} from "./sync.js";

interface MemoryPage extends Page {
  body: string;
  tags: string[];
  inTrash: boolean;
}

class MemoryNotion implements NotionAPI {
  readonly pages: MemoryPage[] = [];
  readonly headings = new Map<string, Array<{ id: string; text: string }>>();
  readonly pageLinks = new Map<string, Map<string, string>>();
  private bodyVersion = 0;

  repositorySourceURL(sourcePath: string): string {
    return `https://github.com/acme/infra/blob/main/${sourcePath}`;
  }

  async prepareRoot(): Promise<void> {}

  async ownerIDs(aliases: string[]): Promise<string[]> {
    return aliases.map((alias) => `user-${alias}`);
  }

  async wikiPages(): Promise<Page[]> {
    return this.pages.filter((page) => !page.inTrash);
  }

  async pageMarkdown(pageID: string): Promise<string> {
    return this.page(pageID).body;
  }

  async createPage(_rootID: string, title: string, body: string): Promise<Page> {
    const page: MemoryPage = {
      id: String(this.pages.length + 1),
      parentID: "",
      title,
      sourcePath: "",
      ownerIDs: [],
      verified: false,
      locked: false,
      body,
      tags: [],
      inTrash: false,
    };
    this.pages.push(page);
    return page;
  }

  async renamePage(pageID: string, title: string): Promise<void> {
    this.page(pageID).title = title;
  }

  async replacePage(pageID: string, body: string, pageLinks = new Map<string, string>()): Promise<void> {
    this.page(pageID).body = body;
    this.pageLinks.set(pageID, pageLinks);
    const version = ++this.bodyVersion;
    this.headings.set(pageID, [...body.matchAll(/^#{1,6} (.+)$/gm)].map((match, index) => ({
      id: `${pageID}-version-${version}-heading-${index}`,
      text: match[1] ?? "",
    })));
  }

  async pageHeadings(pageID: string): Promise<Array<{ id: string; text: string }>> {
    return this.headings.get(pageID) ?? [];
  }

  async rewritePageLinks(pageID: string, links: Map<string, string>): Promise<void> {
    const page = this.page(pageID);
    page.body = page.body.replace(/(\]\()([^\s)]+)(?=[\s)])/g,
      (_match, prefix: string, url: string) => `${prefix}${links.get(url) ?? url}`);
  }

  async publishPage(
    page: Page,
    parentID: string,
    ownerIDs: string[],
    tags: string[],
    sourcePath: string,
  ): Promise<void> {
    const stored = this.page(page.id);
    stored.parentID = parentID;
    stored.ownerIDs = ownerIDs;
    stored.tags = tags;
    stored.sourcePath = sourcePath;
    stored.verified = true;
    stored.locked = true;
  }

  async archivePage(pageID: string): Promise<void> {
    this.page(pageID).inTrash = true;
  }

  private page(pageID: string): MemoryPage {
    const page = this.pages.find((candidate) => candidate.id === pageID);
    assert.ok(page, `page ${pageID} must exist`);
    return page;
  }
}

test("syncDocuments infers subpages and uses index documents as folders", async () => {
  const notion = new MemoryNotion();
  const documents: Document[] = [
    {
      sourcePath: "contributing/quality/testing/index.md",
      repositoryBasePath: "contributing",
      owners: ["andreas"],
      tags: [],
      title: "Testing",
      body: "",
    },
    {
      sourcePath: "contributing/quality/testing/unit-tests.md",
      repositoryBasePath: "contributing",
      owners: ["andreas"],
      tags: [],
      title: "Unit tests",
      body: "",
    },
    {
      sourcePath: "contributing/tooling/README.md",
      repositoryBasePath: "contributing",
      owners: ["andreas"],
      tags: [],
      title: "Tooling",
      body: "",
    },
    {
      sourcePath: "contributing/tooling/builds.md",
      repositoryBasePath: "contributing",
      owners: ["andreas"],
      tags: [],
      title: "Builds",
      body: "",
    },
  ];

  await syncDocuments(notion, documents, "root");

  assert.deepEqual(
    notion.pages.map(({ id, parentID, title, sourcePath, ownerIDs }) => ({
      id,
      parentID,
      title,
      sourcePath,
      ownerIDs,
    })),
    [
      {
        id: "1",
        parentID: "root",
        title: "Quality",
        sourcePath: "contributing/quality/",
        ownerIDs: ["user-andreas"],
      },
      {
        id: "2",
        parentID: "1",
        title: "Testing",
        sourcePath: "contributing/quality/testing/index.md",
        ownerIDs: ["user-andreas"],
      },
      {
        id: "3",
        parentID: "2",
        title: "Unit tests",
        sourcePath: "contributing/quality/testing/unit-tests.md",
        ownerIDs: ["user-andreas"],
      },
      {
        id: "4",
        parentID: "root",
        title: "Tooling",
        sourcePath: "contributing/tooling/README.md",
        ownerIDs: ["user-andreas"],
      },
      {
        id: "5",
        parentID: "4",
        title: "Builds",
        sourcePath: "contributing/tooling/builds.md",
        ownerIDs: ["user-andreas"],
      },
    ],
  );
});

test("syncDocuments reparents an existing flat page without creating a duplicate", async () => {
  const notion = new MemoryNotion();
  notion.pages.push({
    id: "folder",
    parentID: "root",
    title: "Quality",
    sourcePath: "contributing/quality/",
    ownerIDs: [],
    verified: true,
    locked: true,
    body: "Old folder body.\n",
    tags: [],
    inTrash: false,
  });
  notion.pages.push({
    id: "existing",
    parentID: "root",
    title: "Unit tests",
    sourcePath: "contributing/quality/unit-tests.md",
    ownerIDs: ["user-andreas"],
    verified: true,
    locked: true,
    body: "Old body.\n",
    tags: [],
    inTrash: false,
  });

  await syncDocuments(notion, [
    {
      sourcePath: "contributing/quality/unit-tests.md",
      repositoryBasePath: "contributing",
      owners: ["andreas"],
      tags: ["Quality"],
      title: "Unit tests",
      body: "New body.\n",
    },
  ], "root");

  assert.equal(notion.pages.length, 2);
  const folder = notion.pages.find((page) => page.sourcePath === "contributing/quality/");
  assert.ok(folder);
  assert.ok(!folder.body.includes("Old folder body."));
  const document = notion.pages.find((page) => page.id === "existing");
  assert.ok(document);
  assert.equal(document.parentID, folder.id);
  assert.match(document.body, /New body\./);
});

test("syncDocuments trashes removed managed pages but retains unmanaged pages", async () => {
  const notion = new MemoryNotion();
  notion.pages.push(
    {
      id: "folder",
      parentID: "root",
      title: "Removed",
      sourcePath: "contributing/removed/",
      ownerIDs: ["user-andreas"],
      verified: true,
      locked: true,
      body: "",
      tags: [],
      inTrash: false,
    },
    {
      id: "document",
      parentID: "folder",
      title: "Old guide",
      sourcePath: "contributing/removed/guide.md",
      ownerIDs: ["user-andreas"],
      verified: true,
      locked: true,
      body: "Old body.\n",
      tags: [],
      inTrash: false,
    },
    {
      id: "manual",
      parentID: "root",
      title: "Team notes",
      sourcePath: "",
      ownerIDs: [],
      verified: false,
      locked: false,
      body: "Written in Notion.\n",
      tags: [],
      inTrash: false,
    },
  );

  await syncDocuments(notion, [], "root");

  assert.equal(notion.pages.find((page) => page.id === "folder")?.inTrash, true);
  assert.equal(notion.pages.find((page) => page.id === "document")?.inTrash, true);
  assert.equal(notion.pages.find((page) => page.id === "manual")?.inTrash, false);
});

test("syncDocuments resolves forward and circular document links on the first sync", async () => {
  const notion = new MemoryNotion();
  const documents: Document[] = [
    {
      sourcePath: "docs/runbooks/README.md",
      repositoryBasePath: "docs",
      owners: [],
      tags: [],
      title: "Runbooks",
      body: "[`eks/0001-update-nodegroup.md`](eks/0001-update-nodegroup.md)\n",
    },
    {
      sourcePath: "docs/runbooks/eks/0001-update-nodegroup.md",
      repositoryBasePath: "docs",
      owners: [],
      tags: [],
      title: "Nodegroups",
      body: "[Runbooks](../README.md)\n",
    },
  ];

  await syncDocuments(notion, documents, "root");

  const index = notion.pages.find((page) => page.title === "Runbooks");
  const nodegroups = notion.pages.find((page) => page.title === "Nodegroups");
  assert.ok(index && nodegroups);
  assert.ok(index.body.includes(`(https://www.notion.so/${nodegroups.id})`));
  assert.ok(nodegroups.body.includes(`(https://www.notion.so/${index.id})`));
  assert.equal(notion.pageLinks.get(index.id)?.get(`https://www.notion.so/${nodegroups.id}`), nodegroups.id);
  assert.equal(notion.pageLinks.get(nodegroups.id)?.get(`https://www.notion.so/${index.id}`), index.id);
});

test("syncDocuments resolves section links to current Notion heading blocks", async () => {
  const notion = new MemoryNotion();
  const documents: Document[] = [{
    sourcePath: "docs/runbooks/eks/guide.md",
    repositoryBasePath: "docs",
    owners: [],
    tags: [],
    title: "Guide",
    body: [
      "[This section](#draining)",
      "[Other section](guide.md#draining)",
      "[Forward section](other.md#draining)",
      "[Duplicate section](#draining-1)",
      "[Unicode section](#caf%C3%A9)",
      "[Unsynced document](../../unmarked.md)",
      "[External](https://example.com/guide.md#draining)",
      "",
      "## Draining",
      "",
      "## Draining",
      "",
      "## Café",
    ].join("\n"),
  }, {
    sourcePath: "docs/runbooks/eks/other.md", repositoryBasePath: "docs",
    owners: [], tags: [], title: "Other", body: "## Draining\n",
  }];
  for (let run = 0; run < 2; run++) {
    await syncDocuments(notion, documents, "root");
    const page = notion.pages.find((candidate) => candidate.title === "Guide");
    const other = notion.pages.find((candidate) => candidate.title === "Other");
    assert.ok(page && other);
    const [heading, duplicate, unicode] = await notion.pageHeadings(page.id);
    const [otherHeading] = await notion.pageHeadings(other.id);
    assert.ok(heading && duplicate && unicode && otherHeading);
    assert.ok(page.body.includes(`[This section](https://www.notion.so/${page.id}#${heading.id.replaceAll("-", "")})`));
    assert.ok(page.body.includes(`[Other section](https://www.notion.so/${page.id}#${heading.id.replaceAll("-", "")})`));
    assert.ok(page.body.includes(`[Forward section](https://www.notion.so/${other.id}#${otherHeading.id.replaceAll("-", "")})`));
    assert.ok(page.body.includes(`[Duplicate section](https://www.notion.so/${page.id}#${duplicate.id.replaceAll("-", "")})`));
    assert.ok(page.body.includes(`[Unicode section](https://www.notion.so/${page.id}#${unicode.id.replaceAll("-", "")})`));
    assert.ok(page.body.includes("[Unsynced document](https://github.com/acme/infra/blob/main/docs/unmarked.md)"));
    assert.ok(page.body.includes("[External](https://example.com/guide.md#draining)"));
  }
});

test("syncDocuments resolves reference links and encoded paths without changing examples or images", async () => {
  const notion = new MemoryNotion();
  const body = [
    "[Procedure][procedure]",
    "",
    "[procedure]: incident.io/guide.md \"Procedure\"",
    "",
    "[Encoded](incident.io/guide%20two.md)",
    "[Root](/docs/incident.io/guide.md)",
    "`[Example](incident.io/guide.md)`",
    "```md",
    "[Example](incident.io/guide.md)",
    "```",
    "![Image](incident.io/guide.md)",
    "![Reference image][procedure]",
    "[Email](mailto:ops@example.com)",
    "[External](//example.com/guide.md)",
  ].join("\n");
  await syncDocuments(notion, [
    { sourcePath: "docs/README.md", repositoryBasePath: "docs", owners: [], tags: [], title: "Index", body },
    { sourcePath: "docs/incident.io/guide.md", repositoryBasePath: "docs", owners: [], tags: [], title: "Procedure", body: "" },
    { sourcePath: "docs/incident.io/guide two.md", repositoryBasePath: "docs", owners: [], tags: [], title: "Second", body: "" },
  ], "root");
  const index = notion.pages.find((page) => page.title === "Index");
  const procedure = notion.pages.find((page) => page.title === "Procedure");
  const second = notion.pages.find((page) => page.title === "Second");
  assert.ok(index && procedure && second);
  assert.ok(index.body.includes(`[Procedure](https://www.notion.so/${procedure.id} "Procedure")`));
  assert.ok(index.body.includes(`[Encoded](https://www.notion.so/${second.id})`));
  assert.ok(index.body.includes(`[Root](https://www.notion.so/${procedure.id})`));
  for (const unchanged of [
    "[procedure]: incident.io/guide.md \"Procedure\"",
    "`[Example](incident.io/guide.md)`",
    "```md\n[Example](incident.io/guide.md)\n```",
    "![Image](incident.io/guide.md)",
    "![Reference image][procedure]",
    "[Email](mailto:ops@example.com)",
    "[External](//example.com/guide.md)",
  ]) {
    assert.ok(index.body.includes(unchanged), unchanged);
  }
});

test("syncDocuments does not publish updated metadata when a body write fails", async () => {
  class FailingNotion extends MemoryNotion {
    failWrites = false;
    override async replacePage(pageID: string, body: string): Promise<void> {
      if (this.failWrites) {
        throw new Error("Notion write failed");
      }
      await super.replacePage(pageID, body);
    }
  }
  const notion = new FailingNotion();
  const document: Document = {
    sourcePath: "docs/guide.md", repositoryBasePath: "docs", owners: [],
    tags: ["Original"], title: "Guide", body: "Original body.\n",
  };
  await syncDocuments(notion, [document], "root");
  notion.failWrites = true;

  await assert.rejects(syncDocuments(notion, [{
    ...document, tags: ["Updated"], body: "Updated body.\n",
  }], "root"), /Notion write failed/);

  assert.deepEqual(notion.pages[0]?.tags, ["Original"]);
  assert.ok(notion.pages[0]?.body.includes("Original body."));
});
