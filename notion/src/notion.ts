import {
  Client,
  isFullBlock,
  isFullDataSource,
  isFullDatabase,
  isFullPage,
  isFullUser,
  iteratePaginatedAPI,
} from "@notionhq/client";
import type {
  BlockObjectResponse,
  RichTextItemRequest,
  RichTextItemResponse,
  UpdateBlockParameters,
} from "@notionhq/client/build/src/api-endpoints.js";

import type { NotionAPI, Page } from "./sync.js";

const sourceProperty = "Source";
const syncedAtProperty = "Synced at";
const tagsProperty = "Tags";
const parentProperty = "Parent page";

interface WikiRoot {
  dataSourceID: string;
  titleProperty: string;
  ownerProperty: string;
  verificationProperty: string;
}

interface WikiClientOptions {
  baseURL?: string;
  sourceServer?: string;
  sourceRepository?: string;
  sourceRef?: string;
  now?: () => Date;
}

/** WikiClient implements synchronization with the official Notion SDK. */
export class WikiClient implements NotionAPI {
  private readonly client: Client;
  private readonly roots = new Map<string, WikiRoot>();
  private readonly pageRoots = new Map<string, string>();
  private readonly blocksByPage = new Map<string, BlockObjectResponse[]>();
  private readonly owners = new Map<string, string[]>();
  private ownersLoaded = false;
  private readonly sourceServer: string;
  private readonly sourceRepository: string;
  private readonly sourceRef: string;
  private readonly now: () => Date;

  constructor(token: string, options: WikiClientOptions = {}) {
    this.client = new Client({
      auth: token,
      notionVersion: "2026-03-11",
      ...(options.baseURL ? { baseUrl: options.baseURL } : {}),
      timeoutMs: 60_000,
      retry: { maxRetries: 5 },
    });
    this.sourceServer = options.sourceServer ?? process.env.GITHUB_SERVER_URL ?? "https://github.com";
    this.sourceRepository = options.sourceRepository ?? process.env.GITHUB_REPOSITORY ?? "unkeyed/unkey";
    this.sourceRef = options.sourceRef ?? process.env.GITHUB_REF_NAME ?? "main";
    this.now = options.now ?? (() => new Date());
  }

  async prepareRoot(rootID: string): Promise<void> {
    if (this.roots.has(rootID)) {
      return;
    }
    const database = await this.client.databases.retrieve({ database_id: rootID });
    if (!isFullDatabase(database)) {
      throw new Error(`Notion returned a partial database for wiki ${rootID}`);
    }
    if (database.database_type !== "wiki") {
      throw new Error(`Notion root ${rootID} is not a wiki`);
    }
    if (database.data_sources.length !== 1) {
      throw new Error(
        `Notion wiki ${rootID} has ${database.data_sources.length} data sources, expected one`,
      );
    }
    const dataSourceID = database.data_sources[0]?.id;
    if (!dataSourceID) {
      throw new Error(`Notion wiki ${rootID} has no data source ID`);
    }
    const dataSource = await this.client.dataSources.retrieve({ data_source_id: dataSourceID });
    if (!isFullDataSource(dataSource)) {
      throw new Error(`Notion returned a partial data source for wiki ${rootID}`);
    }

    let titleProperty = "";
    let ownerProperty = "";
    let verificationProperty = "";
    for (const [name, property] of Object.entries(dataSource.properties)) {
      const type = propertyType(property);
      if (type === "title") {
        titleProperty = name;
      } else if (name === "Owner" && type === "people") {
        ownerProperty = name;
      } else if (type === "verification") {
        verificationProperty = name;
      }
    }
    if (titleProperty === "" || ownerProperty === "" || verificationProperty === "") {
      throw new Error(`Notion wiki ${rootID} must have title, Owner, and Verification properties`);
    }
    const parent = dataSource.properties[parentProperty];
    if (parent?.type !== "relation" || parent.relation.data_source_id !== dataSourceID) {
      throw new Error(`Notion wiki ${rootID} must have subpages enabled`);
    }
    await this.prepareMetadata(dataSourceID, rootID, dataSource.properties);
    this.roots.set(rootID, {
      dataSourceID,
      titleProperty,
      ownerProperty,
      verificationProperty,
    });
  }

  async ownerIDs(aliases: string[]): Promise<string[]> {
    if (!this.ownersLoaded) {
      await this.loadOwners();
    }
    return aliases.map((alias) => {
      const matches = this.owners.get(alias.toLowerCase()) ?? [];
      if (matches.length === 0) {
        throw new Error(`Notion owner ${JSON.stringify(alias)} was not found`);
      }
      if (matches.length > 1) {
        throw new Error(`Notion owner ${JSON.stringify(alias)} is ambiguous`);
      }
      return matches[0] as string;
    });
  }

  async wikiPages(rootID: string): Promise<Page[]> {
    const root = this.root(rootID);
    const pages: Page[] = [];
    for await (const result of iteratePaginatedAPI(this.client.dataSources.query, {
      data_source_id: root.dataSourceID,
      result_type: "page",
      page_size: 100,
    })) {
      if (!isFullPage(result)) {
        continue;
      }
      const title = result.properties[root.titleProperty];
      const source = result.properties[sourceProperty];
      const owners = result.properties[root.ownerProperty];
      const verification = result.properties[root.verificationProperty];
      const parent = result.properties[parentProperty];
      pages.push({
        id: result.id,
        parentID:
          parent?.type === "relation" && parent.relation[0]?.id
            ? parent.relation[0].id
            : rootID,
        title:
          title?.type === "title" ? title.title.map((text) => text.plain_text).join("") : "",
        sourcePath: source?.type === "url" ? this.repositorySourcePath(source.url ?? "") : "",
        ownerIDs:
          owners?.type === "people" ? owners.people.map((owner) => owner.id) : [],
        verified:
          verification?.type === "verification" &&
          verification.verification?.state === "verified",
        locked: result.is_locked,
      });
      this.pageRoots.set(result.id, rootID);
    }
    return pages;
  }

  async pageMarkdown(pageID: string): Promise<string> {
    return (await this.client.pages.retrieveMarkdown({ page_id: pageID })).markdown;
  }

  async createPage(rootID: string, title: string, body: string): Promise<Page> {
    const root = this.root(rootID);
    const response = await this.client.pages.create({
      parent: { type: "data_source_id", data_source_id: root.dataSourceID },
      properties: {
        [root.titleProperty]: {
          type: "title",
          title: [{ type: "text", text: { content: title } }],
        },
      },
      ...(body === "" ? {} : { markdown: body }),
    });
    this.pageRoots.set(response.id, rootID);
    return {
      id: response.id,
      parentID: rootID,
      title,
      sourcePath: "",
      ownerIDs: [],
      verified: false,
      locked: false,
    };
  }

  async renamePage(pageID: string, title: string): Promise<void> {
    const root = this.pageRoot(pageID);
    await this.client.pages.update({
      page_id: pageID,
      properties: {
        [root.titleProperty]: {
          type: "title",
          title: [{ type: "text", text: { content: title } }],
        },
      },
    });
  }

  async replacePage(pageID: string, body: string, pageLinks = new Map<string, string>()): Promise<void> {
    this.blocksByPage.delete(pageID);
    await this.client.pages.updateMarkdown({
      page_id: pageID,
      type: "replace_content",
      replace_content: { new_str: body, allow_deleting_content: true },
    });
    if (pageLinks.size === 0) {
      return;
    }
    for (const block of await this.pageBlocks(pageID)) {
      if (block.has_children) {
        continue;
      }
      let richText: RichTextItemResponse[];
      switch (block.type) {
        case "paragraph": richText = block.paragraph.rich_text; break;
        case "bulleted_list_item": richText = block.bulleted_list_item.rich_text; break;
        case "numbered_list_item": richText = block.numbered_list_item.rich_text; break;
        default: continue;
      }
      const first = richText[0];
      const url = first?.type === "text" ? first.text.link?.url : undefined;
      const targetID = url ? pageLinks.get(url) : undefined;
      if (!targetID || !richText.every((item) => item.type === "text" && item.text.link?.url === url)) {
        continue;
      }
      const parentID = block.parent.type === "block_id" ? block.parent.block_id
        : block.parent.type === "page_id" ? block.parent.page_id : undefined;
      if (!parentID) {
        throw new Error(`Notion link block ${block.id} has no page or block parent`);
      }
      await this.client.blocks.children.append({
        block_id: parentID,
        position: { type: "after_block", after_block: { id: block.id } },
        children: [{ object: "block", type: "link_to_page",
          link_to_page: { type: "page_id", page_id: targetID } }],
      });
      await this.client.blocks.delete({ block_id: block.id });
    }
    this.blocksByPage.delete(pageID);
  }

  async pageHeadings(pageID: string): Promise<Array<{ id: string; text: string }>> {
    const headings: Array<{ id: string; text: string }> = [];
    for (const block of await this.pageBlocks(pageID)) {
      let richText: RichTextItemResponse[];
      switch (block.type) {
        case "heading_1": richText = block.heading_1.rich_text; break;
        case "heading_2": richText = block.heading_2.rich_text; break;
        case "heading_3": richText = block.heading_3.rich_text; break;
        case "heading_4": richText = block.heading_4.rich_text; break;
        default: continue;
      }
      headings.push({ id: block.id, text: richText.map((item) => item.plain_text).join("") });
    }
    return headings;
  }

  async rewritePageLinks(pageID: string, links: Map<string, string>): Promise<void> {
    for (const block of await this.pageBlocks(pageID)) {
      let changed = false;
      const rewrite = (items: RichTextItemResponse[]): RichTextItemRequest[] => items.map((item) => {
        if (item.type === "text") {
          const url = item.text.link ? links.get(item.text.link.url) : undefined;
          changed ||= url !== undefined;
          return { type: "text", annotations: item.annotations,
            text: { ...item.text, ...(url ? { link: { url } } : {}) } };
        }
        if (item.type === "equation") {
          return { type: "equation", equation: item.equation, annotations: item.annotations };
        }
        if (item.mention.type === "link_preview" || item.mention.type === "link_mention") {
          return { type: "text", annotations: item.annotations,
            text: { content: item.plain_text, link: item.href ? { url: item.href } : null } };
        }
        return { type: "mention", mention: item.mention, annotations: item.annotations };
      });
      let update: UpdateBlockParameters;
      const block_id = block.id;
      switch (block.type) {
        case "heading_1": update = { block_id, heading_1: { rich_text: rewrite(block.heading_1.rich_text) } }; break;
        case "heading_2": update = { block_id, heading_2: { rich_text: rewrite(block.heading_2.rich_text) } }; break;
        case "heading_3": update = { block_id, heading_3: { rich_text: rewrite(block.heading_3.rich_text) } }; break;
        case "heading_4": update = { block_id, heading_4: { rich_text: rewrite(block.heading_4.rich_text) } }; break;
        case "paragraph": update = { block_id, paragraph: { rich_text: rewrite(block.paragraph.rich_text) } }; break;
        case "bulleted_list_item": update = { block_id, bulleted_list_item: { rich_text: rewrite(block.bulleted_list_item.rich_text) } }; break;
        case "numbered_list_item": update = { block_id, numbered_list_item: { rich_text: rewrite(block.numbered_list_item.rich_text) } }; break;
        case "quote": update = { block_id, quote: { rich_text: rewrite(block.quote.rich_text) } }; break;
        case "to_do": update = { block_id, to_do: { rich_text: rewrite(block.to_do.rich_text) } }; break;
        case "toggle": update = { block_id, toggle: { rich_text: rewrite(block.toggle.rich_text) } }; break;
        case "template": update = { block_id, template: { rich_text: rewrite(block.template.rich_text) } }; break;
        case "callout": update = { block_id, callout: { rich_text: rewrite(block.callout.rich_text) } }; break;
        case "table_row": update = { block_id, table_row: { cells: block.table_row.cells.map(rewrite) } }; break;
        default: continue;
      }
      if (changed) {
        await this.client.blocks.update(update);
      }
    }
  }

  private async pageBlocks(pageID: string): Promise<BlockObjectResponse[]> {
    const cached = this.blocksByPage.get(pageID);
    if (cached) {
      return cached;
    }
    const blocks: BlockObjectResponse[] = [];
    const visit = async (blockID: string): Promise<void> => {
      for await (const block of iteratePaginatedAPI(this.client.blocks.children.list, {
        block_id: blockID, page_size: 100,
      })) {
        if (!isFullBlock(block)) {
          throw new Error(`Notion returned a partial block for ${blockID}`);
        }
        blocks.push(block);
        if (block.has_children && block.type !== "child_page" && block.type !== "child_database") {
          await visit(block.id);
        }
      }
    };
    await visit(pageID);
    this.blocksByPage.set(pageID, blocks);
    return blocks;
  }

  async publishPage(
    page: Page,
    parentID: string,
    ownerIDs: string[],
    tags: string[],
    sourcePath: string,
  ): Promise<void> {
    const rootID = this.pageRoots.get(page.id);
    if (!rootID) {
      throw new Error(`Notion page ${page.id} is not a wiki page`);
    }
    const root = this.root(rootID);
    const ownerChanged = !sameIDs(page.ownerIDs, ownerIDs);
    if (!page.verified && ownerChanged) {
      await this.client.pages.update({
        page_id: page.id,
        properties: {
          [root.verificationProperty]: { verification: { state: "verified" } },
        },
      });
    }

    await this.client.pages.update({
      page_id: page.id,
      ...(!page.locked ? { is_locked: true } : {}),
      properties: {
        [sourceProperty]: { url: this.repositorySourceURL(sourcePath) },
        [syncedAtProperty]: { date: { start: this.now().toISOString() } },
        [tagsProperty]: { multi_select: tags.map((name) => ({ name })) },
        [parentProperty]: {
          relation: parentID === rootID ? [] : [{ id: parentID }],
        },
        ...(!page.verified && !ownerChanged
          ? { [root.verificationProperty]: { verification: { state: "verified" as const } } }
          : {}),
        ...(ownerChanged
          ? { [root.ownerProperty]: { people: ownerIDs.map((id) => ({ id })) } }
          : {}),
      },
    });
  }

  async archivePage(pageID: string): Promise<void> {
    await this.client.pages.update({ page_id: pageID, in_trash: true });
  }

  private async prepareMetadata(
    dataSourceID: string,
    rootID: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    const expected = new Map([
      [sourceProperty, "url"],
      [syncedAtProperty, "date"],
      [tagsProperty, "multi_select"],
    ]);
    type UpdateProperties = NonNullable<
      Parameters<Client["dataSources"]["update"]>[0]["properties"]
    >;
    const missing: UpdateProperties = {};
    for (const [name, type] of expected) {
      const property = properties[name];
      const actualType = propertyType(property);
      if (property && actualType !== type) {
        throw new Error(
          `Notion wiki ${rootID} property ${JSON.stringify(name)} must have type ${type}, got ${actualType}`,
        );
      }
      if (!property) {
        if (type === "url") missing[name] = { url: {} };
        if (type === "date") missing[name] = { date: {} };
        if (type === "multi_select") missing[name] = { multi_select: {} };
      }
    }
    if (Object.keys(missing).length > 0) {
      await this.client.dataSources.update({
        data_source_id: dataSourceID,
        properties: missing,
      });
    }
  }

  private async loadOwners(): Promise<void> {
    let cursor: string | undefined;
    do {
      const response = await this.client.users.list({
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      for (const user of response.results) {
        if (!isFullUser(user) || user.type !== "person" || !user.person.email) {
          continue;
        }
        const localPart = user.person.email.toLowerCase().split("@", 1)[0];
        if (!localPart) {
          continue;
        }
        this.owners.set(localPart, [...(this.owners.get(localPart) ?? []), user.id]);
      }
      cursor = response.next_cursor ?? undefined;
    } while (cursor);
    this.ownersLoaded = true;
  }

  repositorySourceURL(sourcePath: string): string {
    const url = new URL(this.sourceServer);
    const folder = sourcePath.endsWith("/");
    const kind = folder ? "tree" : "blob";
    const repositoryPath = sourcePath.replace(/\/$/, "");
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${this.sourceRepository}/${kind}/${this.sourceRef}/${repositoryPath}`;
    return url.toString();
  }

  private repositorySourcePath(source: string): string {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      return "";
    }
    const server = new URL(this.sourceServer);
    if (url.origin !== server.origin) {
      return "";
    }
    const base = `${server.pathname.replace(/\/$/, "")}/${this.sourceRepository}`;
    const pathname = decodeURIComponent(url.pathname);
    const filePrefix = `${base}/blob/${this.sourceRef}/`;
    if (pathname.startsWith(filePrefix)) {
      return pathname.slice(filePrefix.length);
    }
    const folderPrefix = `${base}/tree/${this.sourceRef}/`;
    return pathname.startsWith(folderPrefix) ? `${pathname.slice(folderPrefix.length)}/` : "";
  }

  private root(rootID: string): WikiRoot {
    const root = this.roots.get(rootID);
    if (!root) {
      throw new Error(`Notion root ${rootID} was not prepared`);
    }
    return root;
  }

  private pageRoot(pageID: string): WikiRoot {
    const rootID = this.pageRoots.get(pageID);
    if (!rootID) {
      throw new Error(`Notion page ${pageID} is not a wiki page`);
    }
    return this.root(rootID);
  }
}

function sameIDs(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function propertyType(property: unknown): string {
  return typeof property === "object" && property !== null && "type" in property
    ? String(property.type)
    : "";
}
