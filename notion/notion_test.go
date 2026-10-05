package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestNotionClient_ChildPagesQueriesPreparedWiki(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/v1/databases/wiki":
			_, err := w.Write([]byte(`{"database_type":"wiki","data_sources":[{"id":"source"}]}`))
			require.NoError(t, err)
		case "/v1/data_sources/source":
			_, err := w.Write([]byte(`{"properties":{"Page":{"type":"title"},"Owner":{"type":"people"},"Verification":{"type":"verification"},"Source":{"type":"url"},"Synced at":{"type":"date"}}}`))
			require.NoError(t, err)
		case "/v1/data_sources/source/query":
			require.Equal(t, http.MethodPost, req.Method)
			_, err := w.Write([]byte(`{"results":[{"object":"page","id":"page","is_locked":true,"properties":{"Page":{"type":"title","title":[{"plain_text":"Code quality"}]},"Owner":{"type":"people","people":[{"id":"user-andreas"}]},"Verification":{"type":"verification","verification":{"state":"verified"}},"Source":{"type":"url","url":"https://github.com/unkeyed/unkey/blob/main/docs/code-quality.mdx"}}}],"has_more":false,"next_cursor":null}`))
			require.NoError(t, err)
		default:
			http.NotFound(w, req)
		}
	}))
	t.Cleanup(server.Close)

	client := newNotionClient("token")
	client.baseURL = server.URL
	client.sourceServer = "https://github.com"
	client.sourceRepo = "unkeyed/unkey"
	client.sourceRef = "main"
	require.NoError(t, client.prepareRoot(context.Background(), "wiki"))

	got, err := client.childPages(context.Background(), "wiki")
	require.NoError(t, err)
	require.Equal(t, []page{{
		ID:         "page",
		Title:      "Code quality",
		SourcePath: "docs/code-quality.mdx",
		OwnerIDs:   []string{"user-andreas"},
		Verified:   true,
		Locked:     true,
	}}, got)
}

func TestNotionClient_PrepareRootAddsManagedProperties(t *testing.T) {
	t.Parallel()

	updated := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch {
		case req.Method == http.MethodGet && req.URL.Path == "/v1/databases/wiki":
			_, err := w.Write([]byte(`{"database_type":"wiki","data_sources":[{"id":"source"}]}`))
			require.NoError(t, err)
		case req.Method == http.MethodGet && req.URL.Path == "/v1/data_sources/source":
			_, err := w.Write([]byte(`{"properties":{"Page":{"type":"title"},"Owner":{"type":"people"},"Verification":{"type":"verification"}}}`))
			require.NoError(t, err)
		case req.Method == http.MethodPatch && req.URL.Path == "/v1/data_sources/source":
			payload := map[string]any{}
			require.NoError(t, json.NewDecoder(req.Body).Decode(&payload))
			require.Equal(t, map[string]any{
				"properties": map[string]any{
					"Source":    map[string]any{"type": "url", "url": map[string]any{}},
					"Synced at": map[string]any{"type": "date", "date": map[string]any{}},
					"Tags":      map[string]any{"type": "multi_select", "multi_select": map[string]any{}},
					"Path":      map[string]any{"type": "rich_text", "rich_text": map[string]any{}},
				},
			}, payload)
			updated = true
			_, err := w.Write([]byte(`{"id":"source"}`))
			require.NoError(t, err)
		default:
			http.NotFound(w, req)
		}
	}))
	t.Cleanup(server.Close)

	client := newNotionClient("token")
	client.baseURL = server.URL

	require.NoError(t, client.prepareRoot(context.Background(), "wiki"))
	require.True(t, updated)
}

func TestNotionClient_OrganizeRootGroupsViewByPath(t *testing.T) {
	t.Parallel()

	updated := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		require.Equal(t, "/v1/views/view", req.URL.Path)
		if req.Method == http.MethodGet {
			_, err := w.Write([]byte(`{"object":"view","id":"view","parent":{"type":"database_id","database_id":"wiki"},"data_source_id":"source","type":"table"}`))
			require.NoError(t, err)
			return
		}
		require.Equal(t, http.MethodPatch, req.Method)
		payload := map[string]any{}
		require.NoError(t, json.NewDecoder(req.Body).Decode(&payload))
		require.Equal(t, map[string]any{
			"sorts": []any{
				map[string]any{"property": "Page", "direction": "ascending"},
			},
			"configuration": map[string]any{
				"type": "table",
				"group_by": map[string]any{
					"type":              "text",
					"property_id":       "Path",
					"group_by":          "exact",
					"sort":              map[string]any{"type": "ascending"},
					"hide_empty_groups": true,
				},
			},
		}, payload)
		updated = true
		_, err := w.Write([]byte(`{"id":"view"}`))
		require.NoError(t, err)
	}))
	t.Cleanup(server.Close)

	client := newNotionClient("token")
	client.baseURL = server.URL
	client.roots["wiki"] = wikiRoot{DataSourceID: "source", TitleProperty: "Page", PathProperty: "Path"}

	require.NoError(t, client.organizeRoot(context.Background(), "wiki", "view"))
	require.True(t, updated)
}

func TestNotionClient_OrganizeRootRejectsViewFromAnotherWiki(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		require.Equal(t, http.MethodGet, req.Method)
		require.Equal(t, "/v1/views/view", req.URL.Path)
		_, err := w.Write([]byte(`{"object":"view","id":"view","parent":{"type":"database_id","database_id":"another-wiki"},"data_source_id":"source","type":"table"}`))
		require.NoError(t, err)
	}))
	t.Cleanup(server.Close)

	client := newNotionClient("token")
	client.baseURL = server.URL
	client.roots["wiki"] = wikiRoot{DataSourceID: "source", TitleProperty: "Page", PathProperty: "Path"}

	err := client.organizeRoot(context.Background(), "wiki", "view")
	require.EqualError(t, err, `Notion view view belongs to database another-wiki, not wiki`)
}

func TestNotionClient_OrganizeRootRejectsNonTableView(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		require.Equal(t, http.MethodGet, req.Method)
		_, err := w.Write([]byte(`{"object":"view","id":"view","parent":{"type":"database_id","database_id":"wiki"},"data_source_id":"source","type":"list"}`))
		require.NoError(t, err)
	}))
	t.Cleanup(server.Close)

	client := newNotionClient("token")
	client.baseURL = server.URL
	client.roots["wiki"] = wikiRoot{DataSourceID: "source", TitleProperty: "Page", PathProperty: "Path"}

	err := client.organizeRoot(context.Background(), "wiki", "view")
	require.EqualError(t, err, `Notion view view has type list, expected table`)
}

func TestNotionClient_OrganizeRootRejectsAnotherDataSource(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		require.Equal(t, http.MethodGet, req.Method)
		_, err := w.Write([]byte(`{"object":"view","id":"view","parent":{"type":"database_id","database_id":"wiki"},"data_source_id":"another-source","type":"table"}`))
		require.NoError(t, err)
	}))
	t.Cleanup(server.Close)

	client := newNotionClient("token")
	client.baseURL = server.URL
	client.roots["wiki"] = wikiRoot{DataSourceID: "source", TitleProperty: "Page", PathProperty: "Path"}

	err := client.organizeRoot(context.Background(), "wiki", "view")
	require.EqualError(t, err, `Notion view view uses data source another-source, not source`)
}

func TestNotionClient_CreatePageUsesWikiDataSourceSchema(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/v1/databases/wiki":
			_, err := w.Write([]byte(`{"database_type":"wiki","data_sources":[{"id":"source"}]}`))
			require.NoError(t, err)
		case "/v1/data_sources/source":
			_, err := w.Write([]byte(`{"properties":{"Page":{"type":"title"},"Owner":{"type":"people"},"Verification":{"type":"verification"},"Source":{"type":"url"},"Synced at":{"type":"date"}}}`))
			require.NoError(t, err)
		case "/v1/pages":
			payload := map[string]any{}
			require.NoError(t, json.NewDecoder(req.Body).Decode(&payload))
			require.Equal(t, map[string]any{"type": "data_source_id", "data_source_id": "source"}, payload["parent"])
			properties := payload["properties"].(map[string]any)
			require.Contains(t, properties, "Page")
			require.Equal(t, "Body.\n", payload["markdown"])
			_, err := w.Write([]byte(`{"id":"created"}`))
			require.NoError(t, err)
		default:
			http.NotFound(w, req)
		}
	}))
	t.Cleanup(server.Close)

	client := newNotionClient("token")
	client.baseURL = server.URL
	require.NoError(t, client.prepareRoot(context.Background(), "wiki"))

	got, err := client.createPage(context.Background(), "wiki", "Code quality", "Body.\n")
	require.NoError(t, err)
	require.Equal(t, page{ID: "created", Title: "Code quality"}, got)
}

func TestNotionClient_ReplacePageUsesFullContentReplacement(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		require.Equal(t, http.MethodPatch, req.Method)
		require.Equal(t, "/v1/pages/page/markdown", req.URL.Path)

		payload := map[string]any{}
		require.NoError(t, json.NewDecoder(req.Body).Decode(&payload))
		require.Equal(t, map[string]any{
			"type":            "replace_content",
			"replace_content": map[string]any{"new_str": "New body.\n"},
		}, payload)
		_, err := w.Write([]byte(`{"object":"page_markdown"}`))
		require.NoError(t, err)
	}))
	t.Cleanup(server.Close)

	client := newNotionClient("token")
	client.baseURL = server.URL

	require.NoError(t, client.replacePage(context.Background(), "page", "New body.\n"))
}

func TestNotionClient_ResolvesOwnerAliasesFromEmailLocalParts(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		require.Equal(t, "/v1/users", req.URL.Path)
		_, err := w.Write([]byte(`{
  "results": [
    {"id":"user-andreas","type":"person","person":{"email":"Andreas@unkey.com"}},
    {"id":"user-james","type":"person","person":{"email":"james@unkey.com"}}
  ],
  "has_more": false,
  "next_cursor": null
}`))
		require.NoError(t, err)
	}))
	t.Cleanup(server.Close)

	client := newNotionClient("token")
	client.baseURL = server.URL

	got, err := client.ownerIDs(context.Background(), []string{"andreas", "james"})
	require.NoError(t, err)
	require.Equal(t, []string{"user-andreas", "user-james"}, got)
}

func TestNotionClient_PublishesWikiPageVerificationThenHumanOwner(t *testing.T) {
	t.Setenv("GITHUB_SERVER_URL", "https://github.example.com")
	t.Setenv("GITHUB_REPOSITORY", "acme/handbook")
	t.Setenv("GITHUB_REF_NAME", "stable")

	requests := []map[string]any{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		payload := map[string]any{}
		require.NoError(t, json.NewDecoder(req.Body).Decode(&payload))
		requests = append(requests, payload)
		_, err := w.Write([]byte(`{"id":"page"}`))
		require.NoError(t, err)
	}))
	t.Cleanup(server.Close)

	client := newNotionClient("token")
	client.baseURL = server.URL
	client.now = func() time.Time {
		return time.Date(2026, time.October, 3, 7, 30, 45, 0, time.FixedZone("test", 2*60*60))
	}
	client.roots["wiki"] = wikiRoot{
		OwnerProperty:        "Owner",
		VerificationProperty: "Verification",
		SourceProperty:       "Source",
		SyncedAtProperty:     "Synced at",
		TagsProperty:         "Tags",
		PathProperty:         "Path",
	}
	client.pageRoots["page"] = "wiki"

	require.NoError(t, client.publishPage(
		context.Background(),
		page{ID: "page"},
		[]string{"user-andreas", "user-james"},
		[]string{"Architecture", "API"},
		"docs/guide #1.mdx",
	))
	require.Equal(t, []map[string]any{
		{
			"is_locked": true,
			"properties": map[string]any{
				"Verification": map[string]any{"verification": map[string]any{"state": "verified"}},
			},
		},
		{"properties": map[string]any{
			"Owner": map[string]any{"people": []any{
				map[string]any{"id": "user-andreas"},
				map[string]any{"id": "user-james"},
			}},
			"Source":    map[string]any{"url": "https://github.example.com/acme/handbook/blob/stable/docs/guide%20%231.mdx"},
			"Synced at": map[string]any{"date": map[string]any{"start": "2026-10-03T05:30:45Z"}},
			"Tags": map[string]any{"multi_select": []any{
				map[string]any{"name": "Architecture"},
				map[string]any{"name": "API"},
			}},
			"Path": map[string]any{"rich_text": []any{
				map[string]any{
					"type": "text",
					"text": map[string]any{"content": "Architecture / API"},
				},
			}},
		}},
	}, requests)
}

func TestNotionClient_DoesNotReassignUnchangedOwner(t *testing.T) {
	t.Parallel()

	requests := []map[string]any{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		payload := map[string]any{}
		require.NoError(t, json.NewDecoder(req.Body).Decode(&payload))
		requests = append(requests, payload)
		_, err := w.Write([]byte(`{"id":"page"}`))
		require.NoError(t, err)
	}))
	t.Cleanup(server.Close)

	client := newNotionClient("token")
	client.baseURL = server.URL
	client.roots["wiki"] = wikiRoot{
		OwnerProperty:        "Owner",
		VerificationProperty: "Verification",
		SourceProperty:       "Source",
		SyncedAtProperty:     "Synced at",
		TagsProperty:         "Tags",
		PathProperty:         "Path",
	}
	client.pageRoots["page"] = "wiki"

	require.NoError(t, client.publishPage(
		context.Background(),
		page{ID: "page", OwnerIDs: []string{"user-andreas"}, Verified: true, Locked: true},
		[]string{"user-andreas"},
		[]string{"Architecture"},
		"docs/guide.mdx",
	))
	require.Len(t, requests, 1)
	properties := requests[0]["properties"].(map[string]any)
	require.NotContains(t, properties, "Owner")
}

func TestNotionClient_RetriesRateLimitAfterServerDelay(t *testing.T) {
	t.Parallel()

	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		attempts++
		if attempts == 1 {
			w.Header().Set("Retry-After", "2")
			w.WriteHeader(http.StatusTooManyRequests)
			_, err := w.Write([]byte(`{"code":"rate_limited"}`))
			require.NoError(t, err)
			return
		}
		_, err := w.Write([]byte(`{"markdown":"Body."}`))
		require.NoError(t, err)
	}))
	t.Cleanup(server.Close)

	client := newNotionClient("token")
	client.baseURL = server.URL
	client.jitter = func() time.Duration { return 5 * time.Millisecond }
	waits := []time.Duration{}
	client.wait = func(_ context.Context, duration time.Duration) error {
		waits = append(waits, duration)
		return nil
	}

	markdown, err := client.pageMarkdown(context.Background(), "page")
	require.NoError(t, err)
	require.Equal(t, "Body.", markdown)
	require.Equal(t, 2, attempts)
	require.Equal(t, []time.Duration{2*time.Second + 5*time.Millisecond}, waits)
}
