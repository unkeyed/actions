package main

import (
	"context"
	"fmt"
	"strings"
)

const (
	// generatedHeader reminds readers where edits belong without duplicating the source URL.
	generatedHeader = "<callout icon=\"✏️\" color=\"gray_bg\">\n\tEdits must be made on GitHub.\n</callout>"
	// legacyGeneratedHeaderPrefix identifies pages created before source metadata existed.
	legacyGeneratedHeaderPrefix = "<callout icon=\"⚠️\" color=\"yellow_bg\">\n\tGenerated from `"
)

// page is the stable identity and mutable title of a Notion child page.
type page struct {
	ID         string
	Title      string
	SourcePath string
	OwnerIDs   []string
	Verified   bool
	Locked     bool
}

// notionAPI isolates synchronization and ownership decisions from HTTP transport.
type notionAPI interface {
	prepareRoot(ctx context.Context, rootID string) error
	ownerIDs(ctx context.Context, aliases []string) ([]string, error)
	childPages(ctx context.Context, parentID string) ([]page, error)
	pageMarkdown(ctx context.Context, pageID string) (string, error)
	createPage(ctx context.Context, parentID, title, body string) (page, error)
	renamePage(ctx context.Context, pageID, title string) error
	replacePage(ctx context.Context, pageID, body string) error
	publishPage(ctx context.Context, page page, ownerIDs, tags []string, sourcePath string) error
	archivePage(ctx context.Context, pageID string) error
}

// notionCache prevents repeated child and Markdown reads while documents share
// a wiki. The sync is serial, so the cache does not need synchronization.
type notionCache struct {
	api              notionAPI
	childrenByParent map[string][]page
	markdownByPage   map[string]string
}

// newNotionCache creates an empty cache over the transport implementation.
func newNotionCache(api notionAPI) *notionCache {
	return &notionCache{
		api:              api,
		childrenByParent: map[string][]page{},
		markdownByPage:   map[string]string{},
	}
}

// syncDocuments creates or updates all marked documents beneath their roots. It
// validates target uniqueness before the first remote write to avoid a partial
// sync caused by conflicting source files.
func syncDocuments(ctx context.Context, api notionAPI, documents []document) error {
	roots := []string{}
	seen := map[string]struct{}{}
	for _, document := range documents {
		if _, ok := seen[document.RootPageID]; ok {
			continue
		}
		seen[document.RootPageID] = struct{}{}
		roots = append(roots, document.RootPageID)
	}
	return syncDocumentsForRoots(ctx, api, documents, roots, nil)
}

// syncDocumentsForRoots synchronizes active documents and archives generated
// pages whose source files no longer exist, including in an otherwise empty wiki.
func syncDocumentsForRoots(ctx context.Context, api notionAPI, documents []document, roots []string, onSynced func(document) error) error {
	sources := make(map[string]struct{}, len(documents))
	ownersBySource := make(map[string][]string, len(documents))
	activeSources := make(map[string]map[string]struct{}, len(roots))
	for _, rootID := range roots {
		if _, ok := activeSources[rootID]; ok {
			return fmt.Errorf("Notion root %s is configured more than once", rootID)
		}
		if err := api.prepareRoot(ctx, rootID); err != nil {
			return fmt.Errorf("prepare Notion root %s: %w", rootID, err)
		}
		activeSources[rootID] = map[string]struct{}{}
	}
	for _, document := range documents {
		if _, ok := activeSources[document.RootPageID]; !ok {
			return fmt.Errorf("%s references unconfigured Notion root %s", document.SourcePath, document.RootPageID)
		}
		source := document.RootPageID + "/" + document.SourcePath
		if _, exists := sources[source]; exists {
			return fmt.Errorf("Notion source %q is configured more than once", source)
		}
		sources[source] = struct{}{}
		activeSources[document.RootPageID][document.SourcePath] = struct{}{}
		ownerIDs, err := api.ownerIDs(ctx, document.Owners)
		if err != nil {
			return fmt.Errorf("resolve owners for %s: %w", document.SourcePath, err)
		}
		ownersBySource[document.SourcePath] = ownerIDs
	}

	api = newNotionCache(api)
	for _, document := range documents {
		body := renderDocument(document)
		child, exists, err := findDocumentPage(ctx, api, document.RootPageID, document)
		if err != nil {
			return fmt.Errorf("find page for %s: %w", document.SourcePath, err)
		}
		if exists {
			if child.Title != document.Title {
				if err := api.renamePage(ctx, child.ID, document.Title); err != nil {
					return fmt.Errorf("rename page for %s: %w", document.SourcePath, err)
				}
			}
			err = api.replacePage(ctx, child.ID, body)
		} else {
			child, err = api.createPage(ctx, document.RootPageID, document.Title, body)
		}
		if err != nil {
			return fmt.Errorf("write page for %s: %w", document.SourcePath, err)
		}
		if err := api.publishPage(ctx, child, ownersBySource[document.SourcePath], document.Tags, document.SourcePath); err != nil {
			return fmt.Errorf("publish page for %s: %w", document.SourcePath, err)
		}
		if onSynced != nil {
			if err := onSynced(document); err != nil {
				return fmt.Errorf("report synced page for %s: %w", document.SourcePath, err)
			}
		}
	}
	for _, rootID := range roots {
		children, err := api.childPages(ctx, rootID)
		if err != nil {
			return fmt.Errorf("list pages while cleaning Notion root %s: %w", rootID, err)
		}
		for _, child := range children {
			sourcePath := child.SourcePath
			managed := sourcePath != ""
			if !managed {
				markdown, err := api.pageMarkdown(ctx, child.ID)
				if err != nil {
					return fmt.Errorf("read page %s while cleaning Notion root %s: %w", child.ID, rootID, err)
				}
				sourcePath, managed = generatedSourcePath(markdown)
			}
			if !managed {
				continue
			}
			if _, active := activeSources[rootID][sourcePath]; active {
				continue
			}
			if err := api.archivePage(ctx, child.ID); err != nil {
				return fmt.Errorf("archive page for removed source %s: %w", sourcePath, err)
			}
		}
	}
	return nil
}

// generatedSourcePath extracts the source marker used by earlier tool versions.
func generatedSourcePath(markdown string) (string, bool) {
	remainder, found := strings.CutPrefix(markdown, legacyGeneratedHeaderPrefix)
	if !found {
		return "", false
	}
	sourcePath, _, found := strings.Cut(remainder, "`.")
	return sourcePath, found && sourcePath != ""
}

// renderDocument directs readers to the repository source of truth without
// duplicating the source link stored in page metadata.
func renderDocument(document document) string {
	return generatedHeader + "\n\n" + document.Body
}

// findDocumentPage uses source metadata before title so a wiki can contain
// managed pages with the same title. Title fallback only migrates pages created
// before source metadata existed.
func findDocumentPage(ctx context.Context, api notionAPI, parentID string, document document) (page, bool, error) {
	var empty page
	children, err := api.childPages(ctx, parentID)
	if err != nil {
		return empty, false, err
	}

	sourceMarker := legacyGeneratedHeaderPrefix + document.SourcePath + "`."
	var sourceMatch page
	var migrationMatch page
	var unmanagedTitleMatch page
	for _, child := range children {
		markdown, err := api.pageMarkdown(ctx, child.ID)
		if err != nil {
			return empty, false, err
		}
		if child.SourcePath == document.SourcePath || strings.HasPrefix(markdown, sourceMarker) {
			if sourceMatch.ID != "" {
				return empty, false, fmt.Errorf("multiple pages claim source %s", document.SourcePath)
			}
			sourceMatch = child
			continue
		}
		if child.Title != document.Title || child.SourcePath != "" {
			continue
		}
		if strings.HasPrefix(markdown, generatedHeader) {
			if migrationMatch.ID != "" {
				return empty, false, fmt.Errorf("multiple legacy pages named %q under %s", document.Title, parentID)
			}
			migrationMatch = child
			continue
		}
		if _, managed := generatedSourcePath(markdown); !managed {
			unmanagedTitleMatch = child
		}
	}

	if sourceMatch.ID != "" {
		return sourceMatch, true, nil
	}
	if migrationMatch.ID != "" {
		return migrationMatch, true, nil
	}
	if unmanagedTitleMatch.ID != "" {
		return empty, false, fmt.Errorf("refusing to replace unmanaged Notion page %q", document.Title)
	}
	return empty, false, nil
}

// childPages returns cached direct children or loads them once.
func (c *notionCache) childPages(ctx context.Context, parentID string) ([]page, error) {
	if children, ok := c.childrenByParent[parentID]; ok {
		return children, nil
	}
	children, err := c.api.childPages(ctx, parentID)
	if err != nil {
		return nil, err
	}
	c.childrenByParent[parentID] = children
	return children, nil
}

// pageMarkdown returns cached content or loads the page once.
func (c *notionCache) pageMarkdown(ctx context.Context, pageID string) (string, error) {
	if markdown, ok := c.markdownByPage[pageID]; ok {
		return markdown, nil
	}
	markdown, err := c.api.pageMarkdown(ctx, pageID)
	if err != nil {
		return "", err
	}
	c.markdownByPage[pageID] = markdown
	return markdown, nil
}

// createPage records a successful write in both caches.
func (c *notionCache) createPage(ctx context.Context, parentID, title, body string) (page, error) {
	var empty page
	created, err := c.api.createPage(ctx, parentID, title, body)
	if err != nil {
		return empty, err
	}
	if children, ok := c.childrenByParent[parentID]; ok {
		c.childrenByParent[parentID] = append(children, created)
	}
	c.markdownByPage[created.ID] = body
	return created, nil
}

// renamePage updates the cached child title after Notion accepts the change.
func (c *notionCache) renamePage(ctx context.Context, pageID, title string) error {
	if err := c.api.renamePage(ctx, pageID, title); err != nil {
		return err
	}
	for parentID, children := range c.childrenByParent {
		for i := range children {
			if children[i].ID == pageID {
				children[i].Title = title
				c.childrenByParent[parentID] = children
				return nil
			}
		}
	}
	return nil
}

// replacePage updates cached content after Notion accepts the replacement.
func (c *notionCache) replacePage(ctx context.Context, pageID, body string) error {
	if err := c.api.replacePage(ctx, pageID, body); err != nil {
		return err
	}
	c.markdownByPage[pageID] = body
	return nil
}

// prepareRoot forwards root validation because preparation happens before caching.
func (c *notionCache) prepareRoot(ctx context.Context, rootID string) error {
	return c.api.prepareRoot(ctx, rootID)
}

// ownerIDs forwards owner resolution because owner data has its own client cache.
func (c *notionCache) ownerIDs(ctx context.Context, aliases []string) ([]string, error) {
	return c.api.ownerIDs(ctx, aliases)
}

// publishPage records source identity in the child cache after publication.
func (c *notionCache) publishPage(ctx context.Context, page page, ownerIDs, tags []string, sourcePath string) error {
	if err := c.api.publishPage(ctx, page, ownerIDs, tags, sourcePath); err != nil {
		return err
	}
	for parentID, children := range c.childrenByParent {
		for i := range children {
			if children[i].ID == page.ID {
				children[i].SourcePath = sourcePath
				children[i].OwnerIDs = ownerIDs
				children[i].Verified = true
				children[i].Locked = true
				c.childrenByParent[parentID] = children
				return nil
			}
		}
	}
	return nil
}

// archivePage forwards removal because trash state is not read again in this sync.
func (c *notionCache) archivePage(ctx context.Context, pageID string) error {
	return c.api.archivePage(ctx, pageID)
}
