import path from "node:path";

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
  prepareRoot(rootID: string): Promise<void>;
  ownerIDs(aliases: string[]): Promise<string[]>;
  wikiPages(rootID: string): Promise<Page[]>;
  pageMarkdown(pageID: string): Promise<string>;
  createPage(rootID: string, title: string, body: string): Promise<Page>;
  renamePage(pageID: string, title: string): Promise<void>;
  replacePage(pageID: string, body: string): Promise<void>;
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
  syncedSources: Set<string>;
  onSynced?: (document: Document) => Promise<void> | void;
}

/** syncDocuments publishes documents and removes stale pages from one wiki. */
export async function syncDocuments(
  api: NotionAPI,
  documents: Document[],
  rootID: string,
  onSynced?: (document: Document) => Promise<void> | void,
): Promise<void> {
  const state = await prepareSync(api, documents, rootID, onSynced);

  for (const document of documents) {
    if (state.syncedSources.has(document.sourcePath)) {
      continue;
    }
    const directory = documentDirectory(document);
    const parent = await ensureDirectory(state, document, directory);
    if (state.syncedSources.has(document.sourcePath)) {
      continue;
    }
    const ownerIDs = state.ownerIDsBySource.get(document.sourcePath);
    if (!ownerIDs) {
      throw new Error(`owners for ${document.sourcePath} were not resolved`);
    }
    await syncPage(state, document, parent.id, ownerIDs);
    state.syncedSources.add(document.sourcePath);
    await state.onSynced?.(document);
  }

  await cleanRemovedPages(state);
}

async function prepareSync(
  api: NotionAPI,
  documents: Document[],
  rootID: string,
  onSynced?: (document: Document) => Promise<void> | void,
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
    syncedSources: new Set(),
    ...(onSynced ? { onSynced } : {}),
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
  const page = await syncPage(state, folder, parent.id, ownerIDs);
  state.activeSources.add(folder.sourcePath);
  state.directoryPages.set(key, page);

  if (index) {
    state.syncedSources.add(index.sourcePath);
    await state.onSynced?.(index);
  }
  return page;
}

async function syncPage(
  state: SyncState,
  document: Document,
  parentID: string,
  ownerIDs: string[],
): Promise<Page> {
  let page = await findPage(state, document);
  const body = renderDocument(document);
  if (page) {
    if (page.title !== document.title) {
      await state.api.renamePage(page.id, document.title);
      page.title = document.title;
    }
    await state.api.replacePage(page.id, body);
  } else {
    page = await state.api.createPage(state.rootID, document.title, body);
    state.pages.push(page);
  }
  await state.api.publishPage(
    page,
    parentID,
    ownerIDs,
    document.tags,
    document.sourcePath,
  );
  page.parentID = parentID;
  page.ownerIDs = [...ownerIDs];
  page.sourcePath = document.sourcePath;
  page.verified = true;
  page.locked = true;
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

function renderDocument(document: Document): string {
  return `${generatedHeader}\n\n${document.body}`;
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
