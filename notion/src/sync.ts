import path from "node:path";
import GithubSlugger from "github-slugger";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";

const generatedHeader = `<callout icon="✏️" color="gray_bg">
	Edits must be made on GitHub.
</callout>`;
const legacyGeneratedHeaderPrefix = `<callout icon="⚠️" color="yellow_bg">
	Generated from \``;

/** Document is one validated repository source selected for publication. */
export interface Document {
  sourcePath: string;
  repositoryBasePath: string;
  owners: string[];
  tags: string[];
  title: string;
  body: string;
}

/** Page contains the Notion state used to preserve identity and metadata. */
export interface Page {
  id: string;
  parentID: string;
  title: string;
  sourcePath: string;
  ownerIDs: string[];
  verified: boolean;
  locked: boolean;
}

/** NotionAPI isolates hierarchy and synchronization rules from the SDK. */
export interface NotionAPI {
  repositorySourceURL(sourcePath: string): string;
  prepareRoot(rootID: string): Promise<void>;
  ownerIDs(aliases: string[]): Promise<string[]>;
  wikiPages(rootID: string): Promise<Page[]>;
  pageMarkdown(pageID: string): Promise<string>;
  createPage(rootID: string, title: string, body: string): Promise<Page>;
  renamePage(pageID: string, title: string): Promise<void>;
  replacePage(pageID: string, body: string, pageLinks?: Map<string, string>): Promise<void>;
  pageHeadings(pageID: string): Promise<Array<{ id: string; text: string }>>;
  rewritePageLinks(pageID: string, links: Map<string, string>): Promise<void>;
  publishPage(
    page: Page,
    parentID: string,
    ownerIDs: string[],
    tags: string[],
    sourcePath: string,
  ): Promise<void>;
  archivePage(pageID: string): Promise<void>;
}

interface SyncState {
  api: NotionAPI;
  rootID: string;
  documents: Document[];
  pages: Page[];
  markdownByPage: Map<string, string>;
  ownerIDsBySource: Map<string, string[]>;
  activeSources: Set<string>;
  directoryPages: Map<string, Page>;
  indexByDirectory: Map<string, Document>;
  preparedSources: Set<string>;
  sectionLinksBySource: Map<string, Map<string, { pageID: string; fragment: string }>>;
}

/** syncDocuments publishes documents and removes stale pages from one wiki. */
export async function syncDocuments(
  api: NotionAPI,
  documents: Document[],
  rootID: string,
  onSynced?: (document: Document) => Promise<void> | void,
): Promise<void> {
  const state = await prepareSync(api, documents, rootID);

  for (const document of documents) {
    if (state.preparedSources.has(document.sourcePath)) {
      continue;
    }
    const directory = documentDirectory(document);
    const parent = await ensureDirectory(state, document, directory);
    if (state.preparedSources.has(document.sourcePath)) {
      continue;
    }
    const ownerIDs = state.ownerIDsBySource.get(document.sourcePath);
    if (!ownerIDs) {
      throw new Error(`owners for ${document.sourcePath} were not resolved`);
    }
    await preparePage(state, document, parent.id, ownerIDs);
    state.preparedSources.add(document.sourcePath);
  }

  for (const page of state.pages) {
    if (!state.activeSources.has(page.sourcePath)) {
      continue;
    }
    const document = documents.find((candidate) => candidate.sourcePath === page.sourcePath);
    const rendered = document ? renderDocument(document, state) : undefined;
    await api.replacePage(page.id, rendered?.body ?? generatedHeader, rendered?.pageLinks);
  }

  await resolveSectionLinks(state);

  for (const page of state.pages) {
    if (!state.activeSources.has(page.sourcePath)) {
      continue;
    }
    const document = documents.find((candidate) => candidate.sourcePath === page.sourcePath);
    const ownerIDs = state.ownerIDsBySource.get(page.sourcePath);
    if (!ownerIDs) {
      throw new Error(`owners for ${page.sourcePath} were not resolved`);
    }
    await api.publishPage(page, page.parentID, ownerIDs, document?.tags ?? [], page.sourcePath);
    page.ownerIDs = [...ownerIDs];
    page.verified = true;
    page.locked = true;
    if (document) {
      await onSynced?.(document);
    }
  }

  await cleanRemovedPages(state);
}

async function prepareSync(
  api: NotionAPI,
  documents: Document[],
  rootID: string,
): Promise<SyncState> {
  await api.prepareRoot(rootID);
  const pages = await api.wikiPages(rootID);

  const activeSources = new Set<string>();
  const ownerIDsBySource = new Map<string, string[]>();
  const indexByDirectory = new Map<string, Document>();
  for (const document of documents) {
    if (activeSources.has(document.sourcePath)) {
      throw new Error(`Notion source ${document.sourcePath} is configured more than once`);
    }
    activeSources.add(document.sourcePath);
    ownerIDsBySource.set(document.sourcePath, await api.ownerIDs(document.owners));
    if (isIndexDocument(document.sourcePath)) {
      const key = documentDirectory(document);
      if (indexByDirectory.has(key)) {
        throw new Error(`Notion directory ${key} has more than one index document`);
      }
      indexByDirectory.set(key, document);
    }
  }

  return {
    api,
    rootID,
    documents,
    pages,
    markdownByPage: new Map(),
    ownerIDsBySource,
    activeSources,
    directoryPages: new Map(),
    indexByDirectory,
    preparedSources: new Set(),
    sectionLinksBySource: new Map(),
  };
}

async function ensureDirectory(
  state: SyncState,
  document: Document,
  directory: string,
): Promise<Page> {
  if (directory === ".") {
    return rootPage(state.rootID);
  }
  const key = directory;
  const existing = state.directoryPages.get(key);
  if (existing) {
    return existing;
  }

  const parent = await ensureDirectory(state, document, path.posix.dirname(directory));
  const index = state.indexByDirectory.get(key);
  const folder = index ?? folderDocument(document, directory);
  const ownerIDs = ownersForDirectory(state, document, directory);
  const page = await preparePage(state, folder, parent.id, ownerIDs);
  state.activeSources.add(folder.sourcePath);
  state.directoryPages.set(key, page);

  if (index) {
    state.preparedSources.add(index.sourcePath);
  }
  return page;
}

async function preparePage(
  state: SyncState,
  document: Document,
  parentID: string,
  ownerIDs: string[],
): Promise<Page> {
  let page = await findPage(state, document);
  if (page) {
    if (page.title !== document.title) {
      await state.api.renamePage(page.id, document.title);
      page.title = document.title;
    }
  } else {
    page = await state.api.createPage(state.rootID, document.title, generatedHeader);
    state.pages.push(page);
  }
  page.parentID = parentID;
  page.sourcePath = document.sourcePath;
  state.ownerIDsBySource.set(document.sourcePath, ownerIDs);
  return page;
}

async function findPage(state: SyncState, document: Document): Promise<Page | undefined> {
  const sourceMatches = state.pages.filter((page) => page.sourcePath === document.sourcePath);
  if (sourceMatches.length > 1) {
    throw new Error(`multiple pages claim source ${document.sourcePath}`);
  }
  if (sourceMatches[0]) {
    return sourceMatches[0];
  }

  let migrationMatch: Page | undefined;
  let unmanagedTitleMatch = false;
  const sourceMarker = `${legacyGeneratedHeaderPrefix}${document.sourcePath}\`.`;
  for (const page of state.pages.filter((candidate) => candidate.sourcePath === "")) {
    const markdown = await pageMarkdown(state, page.id);
    if (markdown.startsWith(sourceMarker)) {
      if (migrationMatch) {
        throw new Error(`multiple pages claim source ${document.sourcePath}`);
      }
      migrationMatch = page;
    } else if (page.title === document.title && markdown.startsWith(generatedHeader)) {
      if (migrationMatch) {
        throw new Error(`multiple legacy pages named ${JSON.stringify(document.title)}`);
      }
      migrationMatch = page;
    } else if (page.title === document.title && !generatedSourcePath(markdown)) {
      unmanagedTitleMatch = true;
    }
  }
  if (migrationMatch) {
    return migrationMatch;
  }
  if (unmanagedTitleMatch) {
    throw new Error(`refusing to replace unmanaged Notion page ${JSON.stringify(document.title)}`);
  }
  return undefined;
}

async function cleanRemovedPages(state: SyncState): Promise<void> {
  for (const page of state.pages) {
    const sourcePath = page.sourcePath || generatedSourcePath(await pageMarkdown(state, page.id));
    if (sourcePath && !state.activeSources.has(sourcePath)) {
      await state.api.archivePage(page.id);
    }
  }
}

function ownersForDirectory(
  state: SyncState,
  folderDocument: Document,
  directory: string,
): string[] {
  const ownerIDs = new Set<string>();
  for (const document of state.documents) {
    if (document.repositoryBasePath !== folderDocument.repositoryBasePath) {
      continue;
    }
    const parent = documentDirectory(document);
    if (parent !== directory && !parent.startsWith(`${directory}/`)) {
      continue;
    }
    for (const ownerID of
      state.ownerIDsBySource.get(document.sourcePath) ?? []) {
      ownerIDs.add(ownerID);
    }
  }
  return [...ownerIDs];
}

function folderDocument(document: Document, directory: string): Document {
  return {
    ...document,
    sourcePath: `${path.posix.join(document.repositoryBasePath, directory)}/`,
    tags: [],
    title: directoryTitle(path.posix.basename(directory)),
    body: "",
  };
}

function documentDirectory(document: Document): string {
  if (document.repositoryBasePath === "") {
    return ".";
  }
  const repositoryBasePath = path.posix.normalize(document.repositoryBasePath);
  const sourcePath = path.posix.normalize(document.sourcePath);
  const relativePath = path.posix.relative(repositoryBasePath, sourcePath);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith("../")) {
    throw new Error(
      `${document.sourcePath} is outside its repository base path ${document.repositoryBasePath}`,
    );
  }
  return path.posix.dirname(relativePath);
}

function isIndexDocument(sourcePath: string): boolean {
  const extension = path.posix.extname(sourcePath);
  const basename = path.posix.basename(sourcePath, extension).toLowerCase();
  return basename === "index" || basename === "readme";
}

function directoryTitle(directory: string): string {
  const title = directory.replaceAll(/[-_]/g, " ");
  return title.length === 0 ? title : title[0]?.toUpperCase() + title.slice(1);
}

function rootPage(rootID: string): Page {
  return {
    id: rootID,
    parentID: "",
    title: "",
    sourcePath: "",
    ownerIDs: [],
    verified: false,
    locked: false,
  };
}

function renderDocument(document: Document, state: SyncState): { body: string; pageLinks: Map<string, string> } {
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const pageLinks = new Map<string, string>();
  const nodes: Nodes[] = [];
  function visit(node: Nodes): void {
    nodes.push(node);
    if ("children" in node) {
      node.children.forEach(visit);
    }
  }
  visit(fromMarkdown(document.body));
  const definitions = new Map<string, Extract<Nodes, { type: "definition" }>>();
  for (const node of nodes) {
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node);
    }
  }
  for (const node of nodes) {
    if (node.type !== "link" && node.type !== "linkReference") {
      continue;
    }
    const destination = node.type === "link" ? node : definitions.get(node.identifier);
    if (destination && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(destination.url)) {
      const suffixStart = destination.url.search(/[?#]/);
      const target = suffixStart < 0 ? destination.url : destination.url.slice(0, suffixStart);
      const suffix = suffixStart < 0 ? "" : destination.url.slice(suffixStart);
      let decodedTarget: string;
      try {
        decodedTarget = decodeURIComponent(target);
      } catch {
        decodedTarget = target;
      }
      const sourcePath = decodedTarget === "" ? document.sourcePath
        : decodedTarget.startsWith("/") ? path.posix.normalize(decodedTarget.slice(1))
        : path.posix.normalize(path.posix.join(path.posix.dirname(document.sourcePath), decodedTarget));
      const page = state.pages.find((candidate) =>
        candidate.sourcePath === sourcePath && state.activeSources.has(sourcePath)
      );
      const url = page
        ? `https://www.notion.so/${page.id.replaceAll("-", "")}${suffix}`
        : `${state.api.repositorySourceURL(sourcePath)}${suffix}`;
      if (page && suffix === "") {
        pageLinks.set(url, page.id);
      }
      if (page && new URL(url).hash !== "") {
        const links = state.sectionLinksBySource.get(document.sourcePath) ?? new Map();
        const fragment = new URL(url).hash.slice(1);
        let decodedFragment: string;
        try {
          decodedFragment = decodeURIComponent(fragment);
        } catch {
          decodedFragment = fragment;
        }
        links.set(url, { pageID: page.id, fragment: decodedFragment });
        state.sectionLinksBySource.set(document.sourcePath, links);
      }
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const labelEnd = node.children.at(-1)?.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        const closingBracket = document.body.indexOf("]", labelEnd ?? start + 1);
        const label = document.body.slice(start, closingBracket + 1);
        const title = destination.title ? ` ${JSON.stringify(destination.title)}` : "";
        edits.push({
          start,
          end,
          text: `${label}(${url}${title})`,
        });
      }
    }
  }
  let body = document.body;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  }
  return { body: `${generatedHeader}\n\n${body}`, pageLinks };
}

async function resolveSectionLinks(state: SyncState): Promise<void> {
  const headingURLsByPage = new Map<string, Map<string, string>>();
  for (const links of state.sectionLinksBySource.values()) {
    for (const { pageID } of links.values()) {
      if (headingURLsByPage.has(pageID)) {
        continue;
      }
      const page = state.pages.find((candidate) => candidate.id === pageID);
      const document = state.documents.find((candidate) => candidate.sourcePath === page?.sourcePath);
      const slugger = new GithubSlugger();
      const pageURL = `https://www.notion.so/${pageID.replaceAll("-", "")}`;
      const headings = new Map<string, string>();
      if (document) {
        headings.set(slugger.slug(document.title), pageURL);
      }
      for (const heading of await state.api.pageHeadings(pageID)) {
        headings.set(slugger.slug(heading.text), `${pageURL}#${heading.id.replaceAll("-", "")}`);
      }
      headingURLsByPage.set(pageID, headings);
    }
  }
  for (const page of state.pages) {
    const sectionLinks = state.sectionLinksBySource.get(page.sourcePath);
    if (!sectionLinks) {
      continue;
    }
    const replacements = new Map<string, string>();
    for (const [url, { pageID, fragment }] of sectionLinks) {
      const resolved = headingURLsByPage.get(pageID)?.get(fragment);
      if (!resolved) {
        console.warn(`Notion heading ${JSON.stringify(fragment)} was not found for ${url}; linking to the page`);
      }
      const target = new URL(resolved ?? url);
      if (!resolved) {
        target.hash = "";
      }
      target.search = new URL(url).search;
      replacements.set(url, target.toString());
    }
    await state.api.rewritePageLinks(page.id, replacements);
  }
}

function generatedSourcePath(markdown: string): string {
  if (!markdown.startsWith(legacyGeneratedHeaderPrefix)) {
    return "";
  }
  return markdown.slice(legacyGeneratedHeaderPrefix.length).split("`.", 1)[0] ?? "";
}

async function pageMarkdown(state: SyncState, pageID: string): Promise<string> {
  const cached = state.markdownByPage.get(pageID);
  if (cached !== undefined) {
    return cached;
  }
  const markdown = await state.api.pageMarkdown(pageID);
  state.markdownByPage.set(pageID, markdown);
  return markdown;
}
