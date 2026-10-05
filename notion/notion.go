package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// notionVersion pins the response and request shapes used by the client.
const notionVersion = "2026-03-11"

// notionRequestAttempts bounds retries when Notion asks the client to slow down.
const notionRequestAttempts = 6

const (
	sourcePropertyName   = "Source"
	syncedAtPropertyName = "Synced at"
	tagsPropertyName     = "Tags"
	pathPropertyName     = "Path"
)

// notionClient implements the subset of Notion's API needed by the sync.
type notionClient struct {
	baseURL      string
	token        string
	httpClient   *http.Client
	wait         func(context.Context, time.Duration) error
	jitter       func() time.Duration
	now          func() time.Time
	roots        map[string]wikiRoot
	pageRoots    map[string]string
	owners       map[string][]string
	ownersLoaded bool
	sourceServer string
	sourceRepo   string
	sourceRef    string
}

// wikiRoot records the data source and schema properties behind one wiki.
type wikiRoot struct {
	DataSourceID         string
	TitleProperty        string
	OwnerProperty        string
	VerificationProperty string
	SourceProperty       string
	SyncedAtProperty     string
	TagsProperty         string
	PathProperty         string
}

// newNotionClient creates a client with bounded HTTP and retry timeouts.
func newNotionClient(token string) *notionClient {
	return &notionClient{
		baseURL: "https://api.notion.com",
		token:   token,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		wait: func(ctx context.Context, duration time.Duration) error {
			timer := time.NewTimer(duration)
			defer timer.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-timer.C:
				return nil
			}
		},
		jitter: func() time.Duration {
			return time.Duration(rand.IntN(250)) * time.Millisecond
		},
		now:          time.Now,
		roots:        map[string]wikiRoot{},
		pageRoots:    map[string]string{},
		owners:       map[string][]string{},
		ownersLoaded: false,
		sourceServer: environmentValue("GITHUB_SERVER_URL", "https://github.com"),
		sourceRepo:   environmentValue("GITHUB_REPOSITORY", "unkeyed/unkey"),
		sourceRef:    environmentValue("GITHUB_REF_NAME", "main"),
	}
}

// environmentValue returns the trimmed environment value or its local default.
func environmentValue(name, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}

// prepareRoot validates a wiki database and discovers its data source schema.
func (c *notionClient) prepareRoot(ctx context.Context, rootID string) error {
	if _, ok := c.roots[rootID]; ok {
		return nil
	}
	var database struct {
		DatabaseType string `json:"database_type"`
		DataSources  []struct {
			ID string `json:"id"`
		} `json:"data_sources"`
	}
	if err := c.request(ctx, http.MethodGet, "/v1/databases/"+url.PathEscape(rootID), nil, &database); err != nil {
		return fmt.Errorf("retrieve wiki database: %w", err)
	}
	if database.DatabaseType != "wiki" {
		return fmt.Errorf("Notion root %s is not a wiki", rootID)
	}
	if len(database.DataSources) != 1 {
		return fmt.Errorf("Notion wiki %s has %d data sources, expected one", rootID, len(database.DataSources))
	}

	root := wikiRoot{
		DataSourceID:         database.DataSources[0].ID,
		TitleProperty:        "",
		OwnerProperty:        "",
		VerificationProperty: "",
		SourceProperty:       "",
		SyncedAtProperty:     "",
		TagsProperty:         "",
		PathProperty:         "",
	}
	var dataSource struct {
		Properties map[string]struct {
			Type string `json:"type"`
		} `json:"properties"`
	}
	if err := c.request(ctx, http.MethodGet, "/v1/data_sources/"+url.PathEscape(root.DataSourceID), nil, &dataSource); err != nil {
		return fmt.Errorf("retrieve wiki data source: %w", err)
	}
	for name, property := range dataSource.Properties {
		switch property.Type {
		case "title":
			root.TitleProperty = name
		case "verification":
			root.VerificationProperty = name
		case "people":
			if name == "Owner" {
				root.OwnerProperty = name
			}
		}
	}
	if root.TitleProperty == "" || root.OwnerProperty == "" || root.VerificationProperty == "" {
		return fmt.Errorf("Notion wiki %s must have title, Owner, and Verification properties", rootID)
	}
	if err := c.prepareMetadataProperties(ctx, rootID, &root, dataSource.Properties); err != nil {
		return err
	}
	c.roots[rootID] = root
	return nil
}

// prepareMetadataProperties validates or creates the schema owned by the sync.
func (c *notionClient) prepareMetadataProperties(ctx context.Context, rootID string, root *wikiRoot, properties map[string]struct {
	Type string `json:"type"`
}) error {
	required := map[string]string{
		sourcePropertyName:   "url",
		syncedAtPropertyName: "date",
		tagsPropertyName:     "multi_select",
		pathPropertyName:     "rich_text",
	}
	missing := map[string]any{}
	for name, expectedType := range required {
		property, exists := properties[name]
		if exists && property.Type != expectedType {
			return fmt.Errorf("Notion wiki %s property %q must have type %s, got %s", rootID, name, expectedType, property.Type)
		}
		if !exists {
			missing[name] = map[string]any{"type": expectedType, expectedType: map[string]any{}}
		}
	}
	if len(missing) > 0 {
		payload := map[string]any{"properties": missing}
		path := "/v1/data_sources/" + url.PathEscape(root.DataSourceID)
		if err := c.request(ctx, http.MethodPatch, path, payload, nil); err != nil {
			return fmt.Errorf("add sync properties to Notion wiki %s: %w", rootID, err)
		}
	}
	root.SourceProperty = sourcePropertyName
	root.SyncedAtProperty = syncedAtPropertyName
	root.TagsProperty = tagsPropertyName
	root.PathProperty = pathPropertyName
	return nil
}

// organizeRoot groups the registered table view by the generated document path.
func (c *notionClient) organizeRoot(ctx context.Context, rootID, viewID string) error {
	root, ok := c.roots[rootID]
	if !ok {
		return fmt.Errorf("Notion root %s was not prepared", rootID)
	}
	var view struct {
		Parent struct {
			DatabaseID string `json:"database_id"`
		} `json:"parent"`
		DataSourceID string `json:"data_source_id"`
		Type         string `json:"type"`
	}
	viewPath := "/v1/views/" + url.PathEscape(viewID)
	if err := c.request(ctx, http.MethodGet, viewPath, nil, &view); err != nil {
		return fmt.Errorf("retrieve Notion view %s: %w", viewID, err)
	}
	if canonicalNotionID(view.Parent.DatabaseID) != canonicalNotionID(rootID) {
		return fmt.Errorf("Notion view %s belongs to database %s, not %s", viewID, view.Parent.DatabaseID, rootID)
	}
	if view.Type != "table" {
		return fmt.Errorf("Notion view %s has type %s, expected table", viewID, view.Type)
	}
	if canonicalNotionID(view.DataSourceID) != canonicalNotionID(root.DataSourceID) {
		return fmt.Errorf("Notion view %s uses data source %s, not %s", viewID, view.DataSourceID, root.DataSourceID)
	}
	payload := map[string]any{
		"sorts": []any{
			map[string]string{"property": root.TitleProperty, "direction": "ascending"},
		},
		"configuration": map[string]any{
			"type": "table",
			"group_by": map[string]any{
				"type":              "text",
				"property_id":       root.PathProperty,
				"group_by":          "exact",
				"sort":              map[string]string{"type": "ascending"},
				"hide_empty_groups": true,
			},
		},
	}
	return c.request(ctx, http.MethodPatch, viewPath, payload, nil)
}

// canonicalNotionID removes UUID formatting before IDs from API responses and
// repository configuration are compared.
func canonicalNotionID(id string) string {
	return strings.ToLower(strings.ReplaceAll(id, "-", ""))
}

// childPages returns every direct child page, following Notion pagination.
func (c *notionClient) childPages(ctx context.Context, parentID string) ([]page, error) {
	root, ok := c.roots[parentID]
	if !ok {
		return nil, fmt.Errorf("Notion root %s was not prepared", parentID)
	}
	return c.wikiPages(ctx, parentID, root)
}

// wikiPages returns every page in a prepared wiki data source.
func (c *notionClient) wikiPages(ctx context.Context, rootID string, root wikiRoot) ([]page, error) {
	cursor := ""
	pages := []page{}
	for {
		payload := map[string]any{"page_size": 100, "result_type": "page"}
		if cursor != "" {
			payload["start_cursor"] = cursor
		}
		var response struct {
			Results []struct {
				Object     string `json:"object"`
				ID         string `json:"id"`
				IsLocked   bool   `json:"is_locked"`
				Properties map[string]struct {
					Title []struct {
						PlainText string `json:"plain_text"`
					} `json:"title"`
					URL    string `json:"url"`
					People []struct {
						ID string `json:"id"`
					} `json:"people"`
					Verification struct {
						State string `json:"state"`
					} `json:"verification"`
				} `json:"properties"`
			} `json:"results"`
			HasMore    bool    `json:"has_more"`
			NextCursor *string `json:"next_cursor"`
		}
		path := "/v1/data_sources/" + url.PathEscape(root.DataSourceID) + "/query"
		if err := c.request(ctx, http.MethodPost, path, payload, &response); err != nil {
			return nil, err
		}
		for _, candidate := range response.Results {
			if candidate.Object != "page" {
				continue
			}
			var title strings.Builder
			for _, text := range candidate.Properties[root.TitleProperty].Title {
				title.WriteString(text.PlainText)
			}
			sourcePath, _ := c.repositorySourcePath(candidate.Properties[root.SourceProperty].URL)
			ownerIDs := []string{}
			for _, owner := range candidate.Properties[root.OwnerProperty].People {
				ownerIDs = append(ownerIDs, owner.ID)
			}
			pages = append(pages, page{
				ID:         candidate.ID,
				Title:      title.String(),
				SourcePath: sourcePath,
				OwnerIDs:   ownerIDs,
				Verified:   candidate.Properties[root.VerificationProperty].Verification.State == "verified",
				Locked:     candidate.IsLocked,
			})
			c.pageRoots[candidate.ID] = rootID
		}
		if !response.HasMore {
			return pages, nil
		}
		if response.NextCursor == nil || *response.NextCursor == "" {
			return nil, fmt.Errorf("Notion returned has_more without a cursor")
		}
		cursor = *response.NextCursor
	}
}

// pageMarkdown returns the enhanced Markdown representation of a page.
func (c *notionClient) pageMarkdown(ctx context.Context, pageID string) (string, error) {
	var response struct {
		Markdown string `json:"markdown"`
	}
	if err := c.request(ctx, http.MethodGet, "/v1/pages/"+url.PathEscape(pageID)+"/markdown", nil, &response); err != nil {
		return "", err
	}
	return response.Markdown, nil
}

// ownerIDs resolves lowercase email local-parts to workspace user IDs without
// exposing email addresses in repository frontmatter or error messages.
func (c *notionClient) ownerIDs(ctx context.Context, aliases []string) ([]string, error) {
	if !c.ownersLoaded {
		if err := c.loadOwners(ctx); err != nil {
			return nil, err
		}
	}
	ids := make([]string, 0, len(aliases))
	for _, alias := range aliases {
		matches := c.owners[strings.ToLower(alias)]
		if len(matches) == 0 {
			return nil, fmt.Errorf("Notion owner %q was not found", alias)
		}
		if len(matches) > 1 {
			return nil, fmt.Errorf("Notion owner %q is ambiguous", alias)
		}
		ids = append(ids, matches[0])
	}
	return ids, nil
}

// loadOwners reads all workspace members once and indexes their email local-parts.
func (c *notionClient) loadOwners(ctx context.Context) error {
	cursor := ""
	for {
		query := url.Values{"page_size": {"100"}}
		if cursor != "" {
			query.Set("start_cursor", cursor)
		}
		var response struct {
			Results []struct {
				ID     string `json:"id"`
				Type   string `json:"type"`
				Person struct {
					Email string `json:"email"`
				} `json:"person"`
			} `json:"results"`
			HasMore    bool    `json:"has_more"`
			NextCursor *string `json:"next_cursor"`
		}
		if err := c.request(ctx, http.MethodGet, "/v1/users?"+query.Encode(), nil, &response); err != nil {
			return fmt.Errorf("list Notion users: %w", err)
		}
		for _, user := range response.Results {
			if user.Type != "person" {
				continue
			}
			local, _, found := strings.Cut(strings.ToLower(user.Person.Email), "@")
			if !found || local == "" {
				continue
			}
			c.owners[local] = append(c.owners[local], user.ID)
		}
		if !response.HasMore {
			c.ownersLoaded = true
			return nil
		}
		if response.NextCursor == nil || *response.NextCursor == "" {
			return fmt.Errorf("Notion returned has_more without a cursor")
		}
		cursor = *response.NextCursor
	}
}

// createPage creates a child page with an explicit title and optional body.
func (c *notionClient) createPage(ctx context.Context, parentID, title, body string) (page, error) {
	var empty page
	root, ok := c.roots[parentID]
	if !ok {
		return empty, fmt.Errorf("Notion root %s was not prepared", parentID)
	}
	payload := map[string]any{
		"parent": map[string]string{"type": "data_source_id", "data_source_id": root.DataSourceID},
		"properties": map[string]any{
			root.TitleProperty: titleProperty(title),
		},
	}
	if body != "" {
		payload["markdown"] = body
	}
	var response struct {
		ID string `json:"id"`
	}
	if err := c.request(ctx, http.MethodPost, "/v1/pages", payload, &response); err != nil {
		return empty, err
	}
	if response.ID == "" {
		return empty, fmt.Errorf("Notion created a page without returning its ID")
	}
	c.pageRoots[response.ID] = parentID
	return page{
		ID:         response.ID,
		Title:      title,
		SourcePath: "",
		OwnerIDs:   nil,
		Verified:   false,
		Locked:     false,
	}, nil
}

// renamePage changes only the title of an existing page.
func (c *notionClient) renamePage(ctx context.Context, pageID, title string) error {
	rootID, ok := c.pageRoots[pageID]
	if !ok {
		return fmt.Errorf("Notion page %s is not a direct wiki page", pageID)
	}
	payload := map[string]any{
		"properties": map[string]any{
			c.roots[rootID].TitleProperty: titleProperty(title),
		},
	}
	return c.request(ctx, http.MethodPatch, "/v1/pages/"+url.PathEscape(pageID), payload, nil)
}

// replacePage replaces all page content while preserving the page identity.
func (c *notionClient) replacePage(ctx context.Context, pageID, body string) error {
	payload := map[string]any{
		"type": "replace_content",
		"replace_content": map[string]string{
			"new_str": body,
		},
	}
	return c.request(ctx, http.MethodPatch, "/v1/pages/"+url.PathEscape(pageID)+"/markdown", payload, nil)
}

// publishPage verifies and locks a wiki page before assigning changed owners.
// Notion couples verification to ownership and notifies newly assigned people,
// so unchanged verified pages must not write Owner again.
func (c *notionClient) publishPage(ctx context.Context, page page, ownerIDs, tags []string, sourcePath string) error {
	rootID, ok := c.pageRoots[page.ID]
	if !ok {
		return fmt.Errorf("Notion page %s is not a direct wiki page", page.ID)
	}
	root := c.roots[rootID]
	people := make([]any, len(ownerIDs))
	for i, ownerID := range ownerIDs {
		people[i] = map[string]string{"id": ownerID}
	}
	multiSelect := make([]any, len(tags))
	for i, tag := range tags {
		multiSelect[i] = map[string]string{"name": tag}
	}
	pathText := []any{}
	if len(tags) > 0 {
		pathText = append(pathText, map[string]any{
			"type": "text",
			"text": map[string]string{"content": strings.Join(tags, " / ")},
		})
	}
	path := "/v1/pages/" + url.PathEscape(page.ID)
	ownerChanged := !sameIDs(page.OwnerIDs, ownerIDs)
	if !page.Verified {
		verificationPayload := map[string]any{
			"is_locked": true,
			"properties": map[string]any{
				root.VerificationProperty: map[string]any{
					"verification": map[string]string{"state": "verified"},
				},
			},
		}
		if err := c.request(ctx, http.MethodPatch, path, verificationPayload, nil); err != nil {
			return err
		}
		ownerChanged = true
	} else if !page.Locked {
		if err := c.request(ctx, http.MethodPatch, path, map[string]bool{"is_locked": true}, nil); err != nil {
			return err
		}
	}
	properties := map[string]any{
		root.SourceProperty:   map[string]any{"url": c.repositorySourceURL(sourcePath)},
		root.SyncedAtProperty: map[string]any{"date": map[string]any{"start": c.now().UTC().Format(time.RFC3339)}},
		root.TagsProperty:     map[string]any{"multi_select": multiSelect},
		root.PathProperty:     map[string]any{"rich_text": pathText},
	}
	if ownerChanged {
		properties[root.OwnerProperty] = map[string]any{"people": people}
	}
	metadataPayload := map[string]any{
		"properties": properties,
	}
	return c.request(ctx, http.MethodPatch, path, metadataPayload, nil)
}

// sameIDs compares people properties without depending on Notion's order.
func sameIDs(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	counts := make(map[string]int, len(left))
	for _, id := range left {
		counts[id]++
	}
	for _, id := range right {
		counts[id]--
		if counts[id] < 0 {
			return false
		}
	}
	return true
}

// repositorySourceURL returns the canonical branch link for a source file.
func (c *notionClient) repositorySourceURL(sourcePath string) string {
	server, err := url.Parse(c.sourceServer)
	if err != nil {
		return ""
	}
	server.Path = strings.TrimSuffix(server.Path, "/") + "/" + c.sourceRepo + "/blob/" + c.sourceRef + "/" + sourcePath
	return server.String()
}

// repositorySourcePath extracts a repository path only from URLs created by this tool.
func (c *notionClient) repositorySourcePath(source string) (string, bool) {
	parsed, err := url.Parse(source)
	if err != nil {
		return "", false
	}
	server, err := url.Parse(c.sourceServer)
	if err != nil || parsed.Scheme != server.Scheme || parsed.Host != server.Host {
		return "", false
	}
	prefix := strings.TrimSuffix(server.Path, "/") + "/" + c.sourceRepo + "/blob/" + c.sourceRef + "/"
	sourcePath, found := strings.CutPrefix(parsed.Path, prefix)
	return sourcePath, found && sourcePath != ""
}

// archivePage moves a generated page to Notion's trash.
func (c *notionClient) archivePage(ctx context.Context, pageID string) error {
	payload := map[string]bool{"in_trash": true}
	return c.request(ctx, http.MethodPatch, "/v1/pages/"+url.PathEscape(pageID), payload, nil)
}

// titleProperty builds the title property accepted by child pages.
func titleProperty(title string) map[string]any {
	return map[string]any{
		"type": "title",
		"title": []any{map[string]any{
			"type": "text",
			"text": map[string]string{"content": title},
		}},
	}
}

// request executes one Notion operation and retries only explicit rate-limit or
// overload responses. Other write failures are not safe to retry because Notion
// may have committed the change before returning an error.
func (c *notionClient) request(ctx context.Context, method, path string, payload, response any) error {
	var encoded []byte
	if payload != nil {
		var err error
		encoded, err = json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("encode Notion request: %w", err)
		}
	}

	for attempt := range notionRequestAttempts {
		res, err := c.send(ctx, method, path, encoded, payload != nil)
		if err != nil {
			return err
		}
		if res.StatusCode >= http.StatusOK && res.StatusCode < http.StatusMultipleChoices {
			return decodeResponse(res, response)
		}

		message, readErr := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		closeErr := res.Body.Close()
		if readErr != nil {
			return fmt.Errorf("Notion returned %s and its response could not be read: %w", res.Status, readErr)
		}
		if closeErr != nil {
			return fmt.Errorf("close Notion error response: %w", closeErr)
		}
		blocked := strings.Contains(string(message), `"public_api_request_blocked"`)
		retryable := (res.StatusCode == http.StatusTooManyRequests || res.StatusCode == 529) && !blocked
		if !retryable || attempt == notionRequestAttempts-1 {
			return fmt.Errorf("Notion returned %s: %s", res.Status, bytes.TrimSpace(message))
		}
		if err := c.wait(ctx, retryDelay(res.Header.Get("Retry-After"), attempt)+c.jitter()); err != nil {
			return fmt.Errorf("wait to retry Notion request: %w", err)
		}
	}
	return fmt.Errorf("Notion request exhausted its retry attempts")
}

// send creates a fresh HTTP request so a JSON body can be replayed after a
// rate-limit response.
func (c *notionClient) send(ctx context.Context, method, path string, body []byte, hasBody bool) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create Notion request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Notion-Version", notionVersion)
	if hasBody {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("send Notion request: %w", err)
	}
	return res, nil
}

// decodeResponse consumes and closes a successful response so HTTP connections
// remain reusable across a full repository sync.
func decodeResponse(res *http.Response, response any) error {
	body, readErr := io.ReadAll(res.Body)
	closeErr := res.Body.Close()
	if readErr != nil {
		return fmt.Errorf("read Notion response: %w", readErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close Notion response: %w", closeErr)
	}
	if response == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, response); err != nil {
		return fmt.Errorf("decode Notion response: %w", err)
	}
	return nil
}

// retryDelay honors Notion's Retry-After header and otherwise uses capped
// exponential backoff. The caller adds jitter before waiting.
func retryDelay(retryAfter string, attempt int) time.Duration {
	seconds, err := strconv.Atoi(retryAfter)
	if err == nil && seconds >= 0 {
		return time.Duration(seconds) * time.Second
	}
	delay := time.Duration(1<<attempt) * time.Second
	return min(delay, 30*time.Second)
}
