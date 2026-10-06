# Sync Markdown to Notion

This action synchronizes selected tracked Markdown and MDX files into Notion
wikis. Git remains the source of truth. Generated pages are verified, locked,
and marked with a neutral reminder that edits must be made on GitHub.

## Notion setup

1. Create a Notion internal integration with read, insert, and update content
   capabilities.
2. Enable access to user information, including email addresses. The action uses
   email local-parts to resolve owners without storing full addresses in a public
   repository.
3. Create a root page and turn it into a wiki.
4. Enable subpages on the wiki. The action uses the generated `Parent page`
   relation to match the repository directory hierarchy.
5. Share the wiki with the integration.
6. Open the wiki's `Owner` property settings and set `Notifications` to `None`.
   Notion otherwise notifies a person when the action first assigns ownership.
   The API cannot suppress this notification.
7. Add the integration token to the calling repository as a secret named
   `NOTION_TOKEN`.

The action requires the wiki database ID. In a shared Notion URL, this is the
32-character identifier before the `?`. The action does not modify wiki views.

## Repository setup

Mark each document that must be synchronized:

```mdx
---
notion:
  owners:
    - andreas
  tags:
    - Architecture
    - API
---

# Authentication

This document explains authentication.
```

Files without `notion` frontmatter are ignored. At least one owner is required.
Owner aliases are lowercase email local-parts. For example, `andreas` matches the
workspace member whose email starts with `andreas@`. Matching is exact and
case-insensitive. The action fails if an alias is missing or ambiguous.

The optional ordered `tags` list populates the wiki's `Tags` property. Configure
grouping, sorting, filtering, and other presentation directly in Notion.

Repository directories become generated wiki pages. A marked `index.md` or
`index.mdx` becomes its directory page instead, so the wiki does not contain a
generated folder and a document with the same name. Generated folder pages use
the combined owners of the documents below them. Their `Source` property links
to the corresponding GitHub directory.

The first level-one heading outside a code fence becomes the Notion page title
and is removed from the uploaded body. Existing `title` frontmatter is the
fallback when the document has no level-one heading. Other frontmatter is not
uploaded. Arbitrary MDX imports, expressions, and components are not transformed
and can be rejected by Notion's enhanced Markdown API.

## Workflow

Add a workflow such as `.github/workflows/sync-notion.yaml`:

```yaml
name: Sync Notion

on:
  push:
    branches: [main]
    paths:
      - "**/*.md"
      - "**/*.mdx"
      - ".github/workflows/sync-notion.yaml"
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: notion-sync
  cancel-in-progress: false

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: unkeyed/actions/notion@v1
        with:
          root-page-id: 3ee512d643f38063b525d6c3619c1f69
          repository-base-path: contributing
        env:
          NOTION_TOKEN: ${{ secrets.NOTION_TOKEN }}
```

One action invocation manages one wiki. `root-page-id` identifies that wiki.
`repository-base-path` is the repository path represented by the wiki root. The
action omits this prefix when it infers subpages. It defaults to the repository
root.

Run one sync for a wiki at a time. Concurrent runs can race while creating or
removing pages because Notion does not provide a transactional sync operation.

## Synchronization behavior

The action scans tracked `*.md` and `*.mdx` files with `git ls-files`. It logs
each document immediately after it is fully synchronized. The first run adds
`Source`, `Synced at`, and `Tags` properties when they do not exist. It fails if
a managed property exists with an incompatible type or subpages are disabled. It
does not modify wiki views.

`Source` links to the source file in the calling GitHub repository and provides
stable page identity when a title changes. The action does not replace an
unmanaged Notion page with the same title. It can manage duplicate titles when
their source paths differ.

Every run replaces the generated body, updates metadata, verifies the page, and
locks it against accidental UI edits. A user with full access can still unlock a
page. Give human users view-only access to the wiki if edits must be prohibited.
Notion pages inherit access from their parent, and the public API does not manage
sharing.

When a marked source file is removed, the action moves its generated Notion page
to trash after all remaining documents synchronize successfully. It never
removes pages without a managed `Source` URL or a legacy source marker.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `root-page-id` | Yes | | ID of the Notion wiki managed by this invocation. |
| `repository-base-path` | No | `.` | Repository path represented by the wiki root. |

## Local development

Install dependencies and run all checks from this action directory:

```bash
npm ci
npm run check
```

The build commits `dist/index.cjs` because GitHub runs JavaScript actions without
installing their dependencies. Node 24 executes the bundle directly.

Run the action against the current repository:

```bash
npm run build
env NOTION_TOKEN=ntn_... \
  'INPUT_ROOT-PAGE-ID=3ee512d643f38063b525d6c3619c1f69' \
  'INPUT_REPOSITORY-BASE-PATH=contributing' \
  node dist/index.cjs
```
