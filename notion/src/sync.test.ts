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

  async replacePage(pageID: string, body: string): Promise<void> {
    this.page(pageID).body = body;
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
        sourcePath: "contributing/tooling/",
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
