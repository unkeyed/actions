import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { WikiClient } from "./notion.js";

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
