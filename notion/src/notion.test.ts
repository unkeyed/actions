import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { WikiClient } from "./notion.js";

test("WikiClient makes standalone document links native without changing prose or section links", async (t) => {
  const pageURL = "https://www.notion.so/target";
  const text = (content: string, url: string) => ({
    type: "text", text: { content, link: { url } }, plain_text: content, href: url,
  });
  const block = (id: string, type: string, rich_text: object[]) => ({
    object: "block", id, type, has_children: false,
    parent: { type: "page_id", page_id: "page" },
    [type]: { rich_text },
  });
  let blocks: Array<Record<string, unknown>> = [
    block("standalone", "paragraph", [text("Guide", pageURL)]),
    block("bullet", "bulleted_list_item", [text("guide", pageURL), text(".md", pageURL)]),
    block("prose", "paragraph", [text("See ", ""), text("Guide", pageURL)]),
    block("description", "bulleted_list_item", [text("Guide", pageURL), text(": procedure", "")]),
    block("section", "paragraph", [text("Draining", `${pageURL}#heading`)]),
    block("external", "paragraph", [text("External", "https://example.com")]),
    block("code", "code", [text("Guide", pageURL)]),
    { ...block("children", "bulleted_list_item", [text("Guide", pageURL)]), has_children: true },
    { object: "block", id: "row", type: "table_row", has_children: false,
      table_row: { cells: [[text("Guide", pageURL)]] } },
  ];
  const unchanged = structuredClone(blocks.slice(2));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "", "http://localhost");
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      response.end(JSON.stringify({ object: "list",
        results: url.pathname === "/v1/blocks/page/children" ? blocks : [],
        has_more: false, next_cursor: null }));
    } else if (request.method === "PATCH" && url.pathname === "/v1/pages/page/markdown") {
      response.end(JSON.stringify({ object: "page", id: "page" }));
    } else if (request.method === "PATCH" && url.pathname === "/v1/blocks/page/children") {
      const body = await readJSON(request);
      assert.ok(isRecord(body) && Array.isArray(body.children) && isRecord(body.position));
      assert.ok(isRecord(body.position.after_block));
      const afterID = body.position.after_block.id;
      const index = blocks.findIndex((candidate) => candidate.id === afterID);
      assert.ok(index >= 0);
      blocks.splice(index + 1, 0, ...body.children);
      response.end(JSON.stringify({ object: "list", results: [], has_more: false, next_cursor: null }));
    } else if (request.method === "DELETE") {
      blocks = blocks.filter((candidate) => url.pathname !== `/v1/blocks/${candidate.id}`);
      response.end(JSON.stringify({ object: "block", id: "deleted" }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ object: "error", code: "object_not_found", message: "not found" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const notion = new WikiClient("token", { baseURL: `http://127.0.0.1:${address.port}` });

  await notion.replacePage("page", "Body", new Map([[pageURL, "target"]]));

  assert.deepEqual(blocks, [
    { object: "block", type: "link_to_page", link_to_page: { type: "page_id", page_id: "target" } },
    { object: "block", type: "link_to_page", link_to_page: { type: "page_id", page_id: "target" } },
    ...unchanged,
  ]);
});

test("WikiClient publishes parent relations without Path metadata", async (t) => {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    const body = await readJSON(request);
    requests.push({ method: request.method ?? "", path: request.url ?? "", body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/databases/wiki") {
      response.end(
        JSON.stringify({
          object: "database",
          id: "wiki",
          title: [],
          database_type: "wiki",
          data_sources: [{ id: "source", name: "Wiki" }],
        }),
      );
    } else if (request.url === "/v1/data_sources/source") {
      response.end(JSON.stringify(wikiDataSource()));
    } else if (request.url === "/v1/pages" && request.method === "POST") {
      response.end(JSON.stringify({ object: "page", id: "page" }));
    } else if (request.url === "/v1/pages/page" && request.method === "PATCH") {
      response.end(JSON.stringify({ object: "page", id: "page" }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ object: "error", code: "object_not_found", message: "not found" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const notion = new WikiClient("token", {
    baseURL: `http://127.0.0.1:${address.port}`,
    sourceServer: "https://github.example.com",
    sourceRepository: "acme/handbook",
    sourceRef: "stable",
  });
  await notion.prepareRoot("wiki");
  const page = await notion.createPage("wiki", "Unit tests", "Body.\n");
  await notion.publishPage(
    page,
    "folder",
    ["user-andreas"],
    ["Quality", "Testing"],
    "contributing/quality/unit-tests.md",
  );

  const updates = requests.filter(
    (request) => request.method === "PATCH" && request.path === "/v1/pages/page",
  );
  assert.equal(updates.length, 2);
  const verification = updates[0]?.body;
  assert.ok(isRecord(verification) && isRecord(verification.properties));
  assert.deepEqual(verification.properties.Verification, {
    verification: { state: "verified" },
  });
  assert.equal(Object.hasOwn(verification.properties, "Owner"), false);

  const metadata = updates[1]?.body;
  assert.ok(isRecord(metadata) && isRecord(metadata.properties));
  const properties = metadata.properties;
  assert.equal(Object.hasOwn(properties, "Verification"), false);
  assert.deepEqual(properties.Owner, { people: [{ id: "user-andreas" }] });
  assert.deepEqual(properties["Parent page"], {
    relation: [{ id: "folder" }],
  });
  assert.deepEqual(properties.Source, {
    url: "https://github.example.com/acme/handbook/blob/stable/contributing/quality/unit-tests.md",
  });
  assert.equal(Object.hasOwn(properties, "Path"), false);
});

test("WikiClient reads folder identity and does not rewrite unchanged owners", async (t) => {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    const body = await readJSON(request);
    requests.push({ method: request.method ?? "", path: request.url ?? "", body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/databases/wiki") {
      response.end(
        JSON.stringify({
          object: "database",
          id: "wiki",
          title: [],
          database_type: "wiki",
          data_sources: [{ id: "source", name: "Wiki" }],
        }),
      );
    } else if (request.url === "/v1/data_sources/source") {
      response.end(JSON.stringify(wikiDataSource()));
    } else if (request.url === "/v1/data_sources/source/query") {
      response.end(
        JSON.stringify({
          object: "list",
          results: [
            {
              object: "page",
              id: "folder",
              url: "https://notion.example.com/folder",
              is_locked: true,
              properties: {
                Page: { type: "title", title: [{ plain_text: "Quality" }] },
                Owner: { type: "people", people: [{ id: "user-andreas" }] },
                Verification: {
                  type: "verification",
                  verification: { state: "unverified" },
                },
                Source: {
                  type: "url",
                  url: "https://github.example.com/acme/handbook/tree/stable/contributing/quality",
                },
                "Parent page": { type: "relation", relation: [] },
              },
            },
          ],
          has_more: false,
          next_cursor: null,
        }),
      );
    } else if (request.url === "/v1/pages/folder" && request.method === "PATCH") {
      response.end(JSON.stringify({ object: "page", id: "folder" }));
    } else {
      response.statusCode = 404;
      response.end(
        JSON.stringify({ object: "error", code: "object_not_found", message: "not found" }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const notion = new WikiClient("token", {
    baseURL: `http://127.0.0.1:${address.port}`,
    sourceServer: "https://github.example.com",
    sourceRepository: "acme/handbook",
    sourceRef: "stable",
  });
  await notion.prepareRoot("wiki");
  const pages = await notion.wikiPages("wiki");
  assert.equal(pages.length, 1);
  const page = pages[0];
  assert.ok(page);
  assert.equal(page.sourcePath, "contributing/quality/");

  await notion.publishPage(
    page,
    "wiki",
    ["user-andreas"],
    [],
    "contributing/quality/",
  );

  const updates = requests.filter(
    (request) => request.method === "PATCH" && request.path === "/v1/pages/folder",
  );
  assert.equal(updates.length, 1);
  const update = updates[0]?.body;
  assert.ok(isRecord(update) && isRecord(update.properties));
  assert.deepEqual(update.properties.Verification, {
    verification: { state: "verified" },
  });
  assert.equal(Object.hasOwn(update.properties, "Owner"), false);
});

test("WikiClient updates nested section links without replacing heading blocks", async (t) => {
  const oldURL = "https://www.notion.so/target#draining";
  const newURL = "https://www.notion.so/target#heading";
  const text = (content: string, url: string | null = null) => ({
    type: "text", text: { content, link: url ? { url } : null },
    plain_text: content, href: url,
    annotations: { bold: true, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
  });
  const heading = { object: "block", id: "heading", type: "heading_2", has_children: false,
    heading_2: { rich_text: [text("Draining", oldURL)], color: "blue", is_toggleable: false } };
  const paragraph = { object: "block", id: "paragraph", type: "paragraph", has_children: false,
    paragraph: { rich_text: [text("See "), text("section", oldURL)], color: "default" } };
  const table = { object: "block", id: "table", type: "table", has_children: true,
    table: { table_width: 1, has_column_header: false, has_row_header: false } };
  const row = { object: "block", id: "row", type: "table_row", has_children: false,
    table_row: { cells: [[text("section", oldURL)]] } };
  const code = { object: "block", id: "code", type: "code", has_children: false,
    code: { rich_text: [text("example", oldURL)], caption: [], language: "markdown" } };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "", "http://localhost");
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && url.pathname === "/v1/blocks/page/children") {
      const second = url.searchParams.has("start_cursor");
      response.end(JSON.stringify({ object: "list", results: second ? [table, code] : [heading, paragraph],
        has_more: !second, next_cursor: second ? null : "second" }));
    } else if (request.method === "GET" && url.pathname === "/v1/blocks/table/children") {
      response.end(JSON.stringify({ object: "list", results: [row], has_more: false, next_cursor: null }));
    } else if (request.method === "PATCH") {
      const body = await readJSON(request);
      assert.ok(isRecord(body));
      if (url.pathname === "/v1/blocks/heading") Object.assign(heading.heading_2, body.heading_2);
      else if (url.pathname === "/v1/blocks/paragraph") Object.assign(paragraph.paragraph, body.paragraph);
      else if (url.pathname === "/v1/blocks/row") Object.assign(row.table_row, body.table_row);
      else assert.fail(`unexpected block update: ${url.pathname}`);
      response.end(JSON.stringify({ object: "block", id: url.pathname.split("/").at(-1) }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ object: "error", code: "object_not_found", message: "not found" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const notion = new WikiClient("token", { baseURL: `http://127.0.0.1:${address.port}` });

  assert.deepEqual(await notion.pageHeadings("page"), [{ id: "heading", text: "Draining" }]);
  await notion.rewritePageLinks("page", new Map([[oldURL, newURL]]));

  assert.equal(heading.id, "heading");
  assert.equal(heading.heading_2.rich_text[0]?.text.link?.url, newURL);
  assert.equal(heading.heading_2.color, "blue");
  assert.equal(paragraph.paragraph.rich_text[1]?.text.link?.url, newURL);
  assert.equal(paragraph.paragraph.rich_text[1]?.annotations.bold, true);
  assert.equal(row.table_row.cells[0]?.[0]?.text.link?.url, newURL);
  assert.equal(code.code.rich_text[0]?.text.link?.url, oldURL);
});

function wikiDataSource(): object {
  return {
    object: "data_source",
    id: "source",
    title: [],
    properties: {
      Page: { id: "title", name: "Page", type: "title", title: {} },
      Owner: { id: "owner", name: "Owner", type: "people", people: {} },
      Verification: {
        id: "verification",
        name: "Verification",
        type: "verification",
        verification: {},
      },
      Source: { id: "source-url", name: "Source", type: "url", url: {} },
      "Synced at": { id: "synced-at", name: "Synced at", type: "date", date: {} },
      Tags: {
        id: "tags",
        name: "Tags",
        type: "multi_select",
        multi_select: { options: [] },
      },
      "Parent page": {
        id: "parent",
        name: "Parent page",
        type: "relation",
        relation: {
          data_source_id: "source",
          type: "dual_property",
          dual_property: { synced_property_name: "Sub-page", synced_property_id: "child" },
        },
      },
    },
  };
}

async function readJSON(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString();
  return body === "" ? undefined : (JSON.parse(body) as unknown);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
