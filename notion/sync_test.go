package main

import (
	"context"
	"strconv"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSyncDocuments_CreatesLockedDocument(t *testing.T) {
	t.Parallel()

	api := newMemoryNotion()
	err := syncDocuments(context.Background(), api, []document{
		{
			SourcePath: "svc/api/authentication.mdx",
			RootPageID: "root",
			Tags:       []string{"Architecture", "API"},
			Title:      "Authentication",
			Body:       "Body.\n",
		},
	})
	require.NoError(t, err)
	require.Equal(t, []memoryPage{
		{
			ID:       "1",
			ParentID: "root",
			Title:    "Authentication",
			Body: "<callout icon=\"✏️\" color=\"gray_bg\">\n" +
				"\tEdits must be made on GitHub.\n" +
				"</callout>\n\nBody.\n",
			SourcePath: "svc/api/authentication.mdx",
			Locked:     true,
			OwnerIDs:   []string{},
			Tags:       []string{"Architecture", "API"},
			Verified:   true,
		},
	}, api.pages)
}

func TestSyncDocuments_AllowsDuplicateTitlesWithDistinctSources(t *testing.T) {
	t.Parallel()

	api := newMemoryNotion()
	err := syncDocuments(context.Background(), api, []document{
		{SourcePath: "svc/api/overview.mdx", RootPageID: "root", Title: "Overview"},
		{SourcePath: "svc/frontline/overview.mdx", RootPageID: "root", Title: "Overview"},
	})
	require.NoError(t, err)
	require.Len(t, api.pages, 2)
	require.Equal(t, "svc/api/overview.mdx", api.pages[0].SourcePath)
	require.Equal(t, "svc/frontline/overview.mdx", api.pages[1].SourcePath)
}

func TestSyncDocuments_RefusesToReplaceUnmanagedPage(t *testing.T) {
	t.Parallel()

	api := newMemoryNotion()
	api.pages = []memoryPage{
		{ID: "1", ParentID: "root", Title: "Authentication", Body: "Written in Notion."},
	}
	err := syncDocuments(context.Background(), api, []document{
		{SourcePath: "svc/api/authentication.mdx", RootPageID: "root", Title: "Authentication", Body: "Generated body.\n"},
	})
	require.EqualError(t, err, `find page for svc/api/authentication.mdx: refusing to replace unmanaged Notion page "Authentication"`)
	require.Equal(t, "Written in Notion.", api.pages[0].Body)
}

func TestSyncDocuments_RenamesPageIdentifiedBySourceMetadata(t *testing.T) {
	t.Parallel()

	api := newMemoryNotion()
	api.pages = []memoryPage{
		{
			ID:         "1",
			ParentID:   "root",
			Title:      "Old authentication title",
			Body:       renderDocument(document{Body: "Old body.\n"}),
			SourcePath: "svc/api/authentication.mdx",
		},
	}
	err := syncDocuments(context.Background(), api, []document{
		{SourcePath: "svc/api/authentication.mdx", RootPageID: "root", Title: "Authentication", Body: "New body.\n"},
	})
	require.NoError(t, err)
	require.Len(t, api.pages, 1)
	require.Equal(t, "Authentication", api.pages[0].Title)
	require.Contains(t, api.pages[0].Body, "New body.")
	require.True(t, api.pages[0].Locked)
}

func TestSyncDocuments_ReadsSharedDestinationOnce(t *testing.T) {
	t.Parallel()

	api := newMemoryNotion()
	api.pages = []memoryPage{
		{ID: "1", ParentID: "root", Title: "Authentication", Body: renderDocument(document{SourcePath: "auth.mdx"})},
		{ID: "2", ParentID: "root", Title: "Authorization", Body: renderDocument(document{SourcePath: "authorization.mdx"})},
	}
	err := syncDocuments(context.Background(), api, []document{
		{SourcePath: "auth.mdx", RootPageID: "root", Title: "Authentication"},
		{SourcePath: "authorization.mdx", RootPageID: "root", Title: "Authorization"},
	})
	require.NoError(t, err)
	require.Equal(t, map[string]int{"root": 1}, api.childPageCalls)
	require.Equal(t, map[string]int{"1": 1, "2": 1}, api.markdownCalls)
}

func TestSyncDocuments_UsesEachDocumentRootPage(t *testing.T) {
	t.Parallel()

	api := newMemoryNotion()
	err := syncDocuments(context.Background(), api, []document{
		{SourcePath: "auth.mdx", RootPageID: "engineering-root", Title: "Authentication"},
		{SourcePath: "sales.mdx", RootPageID: "sales-root", Title: "Pipeline"},
	})
	require.NoError(t, err)
	require.Equal(t, "engineering-root", api.pages[0].ParentID)
	require.Equal(t, "sales-root", api.pages[1].ParentID)
}

func TestSyncDocuments_AllowsSamePathInDifferentRoots(t *testing.T) {
	t.Parallel()

	api := newMemoryNotion()
	err := syncDocuments(context.Background(), api, []document{
		{SourcePath: "engineering.mdx", RootPageID: "engineering-root", Title: "Overview"},
		{SourcePath: "sales.mdx", RootPageID: "sales-root", Title: "Overview"},
	})
	require.NoError(t, err)
}

func TestSyncDocuments_CreatesDocumentDirectlyUnderRoot(t *testing.T) {
	t.Parallel()

	api := newMemoryNotion()
	err := syncDocuments(context.Background(), api, []document{
		{SourcePath: "overview.mdx", RootPageID: "engineering-root", Owners: []string{"andreas"}, Title: "Overview"},
	})
	require.NoError(t, err)
	require.Equal(t, "engineering-root", api.pages[0].ParentID)
	require.Equal(t, []string{"user-andreas"}, api.pages[0].OwnerIDs)
	require.True(t, api.pages[0].Verified)
	require.True(t, api.pages[0].Locked)
}

func TestSyncDocumentsForRoots_ArchivesGeneratedPageWithoutSource(t *testing.T) {
	t.Parallel()

	api := newMemoryNotion()
	api.pages = []memoryPage{
		{ID: "generated", ParentID: "root", Title: "Removed", Body: renderDocument(document{}), SourcePath: "removed.md"},
		{ID: "human", ParentID: "root", Title: "Notes", Body: "Written in Notion."},
	}

	err := syncDocumentsForRoots(context.Background(), api, nil, []string{"root"}, nil)
	require.NoError(t, err)
	require.True(t, api.pages[0].InTrash)
	require.False(t, api.pages[1].InTrash)
}

func TestSyncDocumentsForRoots_ArchivesLegacyGeneratedPageWithoutSource(t *testing.T) {
	t.Parallel()

	api := newMemoryNotion()
	api.pages = []memoryPage{{
		ID:       "legacy",
		ParentID: "root",
		Title:    "Removed",
		Body: legacyGeneratedHeaderPrefix +
			"removed.md`. Edit the source file instead.\n</callout>",
	}}

	err := syncDocumentsForRoots(context.Background(), api, nil, []string{"root"}, nil)
	require.NoError(t, err)
	require.True(t, api.pages[0].InTrash)
}

func TestSyncDocumentsForRoots_ReportsEachCompletedDocument(t *testing.T) {
	t.Parallel()

	api := newMemoryNotion()
	reported := []string{}
	documents := []document{
		{SourcePath: "docs/first.md", RootPageID: "root", Owners: []string{"andreas"}, Title: "First"},
		{SourcePath: "docs/second.mdx", RootPageID: "root", Owners: []string{"james"}, Title: "Second"},
	}
	err := syncDocumentsForRoots(context.Background(), api, documents, []string{"root"}, func(document document) error {
		reported = append(reported, document.SourcePath)
		return nil
	})
	require.NoError(t, err)
	require.Equal(t, []string{"docs/first.md", "docs/second.mdx"}, reported)
}

type memoryPage struct {
	ID         string
	ParentID   string
	Title      string
	Body       string
	SourcePath string
	Locked     bool
	OwnerIDs   []string
	Tags       []string
	Verified   bool
	InTrash    bool
}

type memoryNotion struct {
	pages          []memoryPage
	childPageCalls map[string]int
	markdownCalls  map[string]int
}

func newMemoryNotion() *memoryNotion {
	return &memoryNotion{
		pages:          []memoryPage{},
		childPageCalls: map[string]int{},
		markdownCalls:  map[string]int{},
	}
}

func (n *memoryNotion) prepareRoot(_ context.Context, _ string) error {
	return nil
}

func (n *memoryNotion) ownerIDs(_ context.Context, aliases []string) ([]string, error) {
	ids := make([]string, len(aliases))
	for i, alias := range aliases {
		ids[i] = "user-" + alias
	}
	return ids, nil
}

func (n *memoryNotion) childPages(_ context.Context, parentID string) ([]page, error) {
	n.childPageCalls[parentID]++
	children := []page{}
	for _, candidate := range n.pages {
		if candidate.ParentID == parentID {
			children = append(children, page{ID: candidate.ID, Title: candidate.Title, SourcePath: candidate.SourcePath})
		}
	}
	return children, nil
}

func (n *memoryNotion) pageMarkdown(_ context.Context, pageID string) (string, error) {
	n.markdownCalls[pageID]++
	for _, candidate := range n.pages {
		if candidate.ID == pageID {
			return candidate.Body, nil
		}
	}
	return "", nil
}

func (n *memoryNotion) createPage(_ context.Context, parentID, title, body string) (page, error) {
	id := strconv.Itoa(len(n.pages) + 1)
	n.pages = append(n.pages, memoryPage{ID: id, ParentID: parentID, Title: title, Body: body})
	return page{ID: id, Title: title}, nil
}

func (n *memoryNotion) renamePage(_ context.Context, pageID, title string) error {
	for i := range n.pages {
		if n.pages[i].ID == pageID {
			n.pages[i].Title = title
			return nil
		}
	}
	return nil
}

func (n *memoryNotion) replacePage(_ context.Context, pageID, body string) error {
	for i := range n.pages {
		if n.pages[i].ID == pageID {
			n.pages[i].Body = body
			return nil
		}
	}
	return nil
}

func (n *memoryNotion) publishPage(_ context.Context, page page, ownerIDs, tags []string, sourcePath string) error {
	for i := range n.pages {
		if n.pages[i].ID == page.ID {
			n.pages[i].OwnerIDs = ownerIDs
			n.pages[i].Tags = tags
			n.pages[i].SourcePath = sourcePath
			n.pages[i].Verified = true
			n.pages[i].Locked = true
			return nil
		}
	}
	return nil
}

func (n *memoryNotion) archivePage(_ context.Context, pageID string) error {
	for i := range n.pages {
		if n.pages[i].ID == pageID {
			n.pages[i].InTrash = true
			return nil
		}
	}
	return nil
}
