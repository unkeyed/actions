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
4. Share the wiki with the integration.
5. Open the wiki's `Owner` property settings and set `Notifications` to `None`.
   Notion otherwise notifies a person when the action first assigns ownership.
   The API cannot suppress this notification.
6. Add the integration token to the calling repository as a secret named
   `NOTION_TOKEN`.

The action requires the wiki database ID. In a shared Notion URL, this is the
32-character identifier before the `?`. The action does not modify wiki views.

## Repository setup

Create `.github/notion.yaml` in the repository that contains the documents:

```yaml
roots:
  - pageID: 3ee512d643f38063b525d6c3619c1f69
```

`pageID` identifies the wiki database. IDs can contain UUID dashes or omit them.
Every `rootPageID` used in document frontmatter must exist in this registry. The
registry also lets the action clean a wiki after its last marked source file is
removed.

Mark each document that must be synchronized:

```mdx
---
notion:
  rootPageID: 3ee512d643f38063b525d6c3619c1f69
  owners:
    - andreas
  tags:
    - Architecture
    - API
---

# Authentication

This document explains authentication.
```

Files without `notion` frontmatter are ignored. `rootPageID` and at least one
owner are required. Owner aliases are lowercase email local-parts. For example,
`andreas` matches the workspace member whose email starts with `andreas@`.
Matching is exact and case-insensitive. The action fails if an alias is missing
or ambiguous.

The optional ordered `tags` list populates the wiki's `Tags` property and its
generated `Path` property. For example, `Architecture`, `Services`, and
`Frontline` produce `Architecture / Services / Frontline`. Configure grouping,
sorting, filtering, and other presentation directly in Notion.

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
      - ".github/notion.yaml"
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
        env:
          NOTION_TOKEN: ${{ secrets.NOTION_TOKEN }}
```

Run one sync for a wiki at a time. Concurrent runs can race while creating or
removing pages because Notion does not provide a transactional sync operation.

## Synchronization behavior

The action scans tracked `*.md` and `*.mdx` files with `git ls-files`. It logs
each document immediately after it is fully synchronized. The first run adds
`Source`, `Synced at`, `Tags`, and `Path` properties when they do not exist. It
fails if a managed property exists with an incompatible type. It does not modify
wiki views.

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
| `config` | No | `.github/notion.yaml` | Repository-relative root registry path. |

## Local development

Run tests from this action directory:

```bash
go test ./...
```

Run the command against the current repository:

```bash
NOTION_TOKEN=ntn_... go run .
```
