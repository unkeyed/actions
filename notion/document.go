package main

import (
	"encoding/hex"
	"fmt"
	"strings"

	"go.yaml.in/yaml/v3"
)

// document is the validated repository input used to render one Notion page.
type document struct {
	SourcePath string
	RootPageID string
	Owners     []string
	Tags       []string
	Title      string
	Body       string
}

// frontmatter contains only the metadata that controls Notion publication.
type frontmatter struct {
	Title  string    `yaml:"title"`
	Notion yaml.Node `yaml:"notion"`
}

// notionFrontmatter defines the required configuration for a marked document.
type notionFrontmatter struct {
	RootPageID   string   `yaml:"rootPageID"`
	RelativePath string   `yaml:"relativePath"`
	Owners       []string `yaml:"owners"`
	Tags         []string `yaml:"tags"`
}

// parseDocument ignores unmarked files and validates every field needed for a
// deterministic Notion destination. It removes frontmatter and the title H1
// from the body because Notion stores the page title separately.
func parseDocument(sourcePath string, source []byte) (document, bool, error) {
	var empty document
	content := strings.ReplaceAll(string(source), "\r\n", "\n")
	parts := strings.SplitN(content, "---\n", 3)
	if len(parts) != 3 || parts[0] != "" {
		return empty, false, nil
	}

	var metadata frontmatter
	err := yaml.Unmarshal([]byte(parts[1]), &metadata)
	if err != nil {
		return empty, false, fmt.Errorf("parse frontmatter in %s: %w", sourcePath, err)
	}
	if metadata.Notion.Kind == 0 {
		return empty, false, nil
	}
	var notion notionFrontmatter
	if err := metadata.Notion.Decode(&notion); err != nil {
		return empty, false, fmt.Errorf("parse notion frontmatter in %s: %w", sourcePath, err)
	}
	if strings.TrimSpace(notion.RootPageID) == "" {
		return empty, false, fmt.Errorf("marked document %s has no Notion root page ID", sourcePath)
	}
	rootPageID, err := parseRootPageID(notion.RootPageID)
	if err != nil {
		return empty, false, fmt.Errorf("marked document %s has invalid Notion root page ID: %w", sourcePath, err)
	}
	if strings.TrimSpace(notion.RelativePath) != "" {
		return empty, false, fmt.Errorf("marked document %s has a relativePath, which Notion wiki pages do not support", sourcePath)
	}
	owners := make([]string, len(notion.Owners))
	for i, owner := range notion.Owners {
		owners[i] = strings.ToLower(strings.TrimSpace(owner))
	}
	if len(owners) == 0 {
		return empty, false, fmt.Errorf("marked document %s has no Notion owner", sourcePath)
	}
	for _, owner := range owners {
		if owner == "" {
			return empty, false, fmt.Errorf("marked document %s has an empty Notion owner", sourcePath)
		}
	}
	tags := make([]string, len(notion.Tags))
	for i, tag := range notion.Tags {
		tags[i] = strings.TrimSpace(tag)
		if tags[i] == "" {
			return empty, false, fmt.Errorf("marked document %s has an empty Notion tag", sourcePath)
		}
	}
	lines := strings.Split(parts[2], "\n")
	fence := ""
	for i, line := range lines {
		if marker := fenceMarker(strings.TrimSpace(line)); marker != "" {
			if fence == "" {
				fence = marker
			} else if strings.HasPrefix(marker, fence) {
				fence = ""
			}
			continue
		}
		if fence != "" {
			continue
		}
		level, title, heading := markdownHeading(line)
		if !heading {
			continue
		}
		if level != 1 {
			if strings.TrimSpace(metadata.Title) != "" {
				continue
			}
			return empty, false, fmt.Errorf("marked document %s must start with a level-one heading", sourcePath)
		}
		if title == "" {
			return empty, false, fmt.Errorf("marked document %s has an empty level-one heading", sourcePath)
		}
		body := strings.TrimSpace(strings.Join(append(lines[:i], lines[i+1:]...), "\n"))
		if body != "" {
			body += "\n"
		}
		return document{
			SourcePath: sourcePath,
			RootPageID: rootPageID,
			Owners:     owners,
			Tags:       tags,
			Title:      title,
			Body:       body,
		}, true, nil
	}
	if title := strings.TrimSpace(metadata.Title); title != "" {
		body := strings.TrimSpace(parts[2])
		if body != "" {
			body += "\n"
		}
		return document{
			SourcePath: sourcePath,
			RootPageID: rootPageID,
			Owners:     owners,
			Tags:       tags,
			Title:      title,
			Body:       body,
		}, true, nil
	}

	return empty, false, fmt.Errorf("marked document %s has no level-one heading", sourcePath)
}

// parseRootPageID validates a Notion UUID and removes dashes so equivalent IDs
// use one wiki cache key.
func parseRootPageID(value string) (string, error) {
	value = strings.ReplaceAll(strings.TrimSpace(value), "-", "")
	if len(value) != 32 {
		return "", fmt.Errorf("must contain 32 hexadecimal characters")
	}
	if _, err := hex.DecodeString(value); err != nil {
		return "", fmt.Errorf("must be a UUID: %w", err)
	}
	return strings.ToLower(value), nil
}

// markdownHeading parses an ATX heading without interpreting inline Markdown.
func markdownHeading(line string) (int, string, bool) {
	level := 0
	for level < len(line) && level < 6 && line[level] == '#' {
		level++
	}
	if level == 0 {
		return 0, "", false
	}
	if len(line) == level {
		return level, "", true
	}
	if line[level] != ' ' {
		return 0, "", false
	}
	return level, strings.TrimSpace(line[level+1:]), true
}

// fenceMarker returns the opening sequence for backtick and tilde code fences.
func fenceMarker(line string) string {
	if len(line) < 3 || line[0] != '`' && line[0] != '~' {
		return ""
	}
	end := 1
	for end < len(line) && line[end] == line[0] {
		end++
	}
	if end < 3 {
		return ""
	}
	return line[:end]
}
