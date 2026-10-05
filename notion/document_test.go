package main

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParseDocument_MarkedDocumentUsesRootAndFirstHeading(t *testing.T) {
	t.Parallel()

	source := []byte(`---
notion:
  rootPageID: 195de9221179449fab8075a27c979105
  owners: [andreas]
  tags:
    - Architecture
    - API
---

# Authentication

This document explains authentication.
`)

	got, marked, err := parseDocument("svc/api/authentication.mdx", source)
	require.NoError(t, err)
	require.True(t, marked)
	require.Equal(t, document{
		SourcePath: "svc/api/authentication.mdx",
		RootPageID: "195de9221179449fab8075a27c979105",
		Owners:     []string{"andreas"},
		Tags:       []string{"Architecture", "API"},
		Title:      "Authentication",
		Body:       "This document explains authentication.\n",
	}, got)
}

func TestParseDocument_NormalizesDashedRootPageID(t *testing.T) {
	t.Parallel()

	source := []byte(`---
notion:
  rootPageID: 195de922-1179-449f-ab80-75a27c979105
  owners: [andreas]
---

# Authentication
`)

	got, marked, err := parseDocument("svc/api/authentication.mdx", source)
	require.NoError(t, err)
	require.True(t, marked)
	require.Equal(t, "195de9221179449fab8075a27c979105", got.RootPageID)
}

func TestParseDocument_MarkedDocumentRequiresRootPageID(t *testing.T) {
	t.Parallel()

	source := []byte(`---
notion: {}
---

# Authentication
`)

	_, _, err := parseDocument("svc/api/authentication.mdx", source)
	require.EqualError(t, err, "marked document svc/api/authentication.mdx has no Notion root page ID")
}

func TestParseDocument_NullNotionKeyIsMarkedButInvalid(t *testing.T) {
	t.Parallel()

	source := []byte(`---
notion:
---

# Authentication
`)

	_, marked, err := parseDocument("svc/api/authentication.mdx", source)
	require.False(t, marked)
	require.EqualError(t, err, "marked document svc/api/authentication.mdx has no Notion root page ID")
}

func TestParseDocument_NormalizesWindowsLineEndings(t *testing.T) {
	t.Parallel()

	source := []byte("---\r\nnotion:\r\n  rootPageID: 195de9221179449fab8075a27c979105\r\n  owners: [andreas]\r\n---\r\n\r\n# Authentication\r\n\r\nBody.\r\n")

	got, marked, err := parseDocument("svc/api/authentication.mdx", source)
	require.NoError(t, err)
	require.True(t, marked)
	require.Equal(t, "Body.\n", got.Body)
}

func TestParseDocument_IgnoresHeadingsInsideCodeFences(t *testing.T) {
	t.Parallel()

	source := []byte(`---
notion:
  rootPageID: 195de9221179449fab8075a27c979105
  owners: [andreas]
---

` + "```markdown" + `
# Example
` + "```" + `

# Authentication

Body.
`)

	got, marked, err := parseDocument("svc/api/authentication.mdx", source)
	require.NoError(t, err)
	require.True(t, marked)
	require.Equal(t, "Authentication", got.Title)
}

func TestParseDocument_RequiresFirstHeadingToBeLevelOne(t *testing.T) {
	t.Parallel()

	source := []byte(`---
notion:
  rootPageID: 195de9221179449fab8075a27c979105
  owners: [andreas]
---

## Overview

# Authentication
`)

	_, _, err := parseDocument("svc/api/authentication.mdx", source)
	require.EqualError(t, err, "marked document svc/api/authentication.mdx must start with a level-one heading")
}

func TestParseDocument_UsesFrontmatterTitleWhenDocumentHasNoHeading(t *testing.T) {
	t.Parallel()

	source := []byte(`---
title: Code quality
notion:
  rootPageID: 195de9221179449fab8075a27c979105
  owners: [andreas]
---

This guide defines the coding standards.
`)

	got, marked, err := parseDocument("docs/engineering/code-quality.mdx", source)
	require.NoError(t, err)
	require.True(t, marked)
	require.Equal(t, "Code quality", got.Title)
	require.Equal(t, "This guide defines the coding standards.\n", got.Body)
}

func TestParseDocument_NormalizesOwnerAliases(t *testing.T) {
	t.Parallel()

	source := []byte(`---
title: Code quality
notion:
  rootPageID: 195de9221179449fab8075a27c979105
  owners:
    - Andreas
    - james
---
`)

	got, marked, err := parseDocument("docs/engineering/code-quality.mdx", source)
	require.NoError(t, err)
	require.True(t, marked)
	require.Equal(t, []string{"andreas", "james"}, got.Owners)
}

func TestParseDocument_TrimsTagsWithoutChangingCase(t *testing.T) {
	t.Parallel()

	source := []byte(`---
title: Code quality
notion:
  rootPageID: 195de9221179449fab8075a27c979105
  owners: [andreas]
  tags:
    - " Architecture "
    - API
---
`)

	got, marked, err := parseDocument("docs/engineering/code-quality.mdx", source)
	require.NoError(t, err)
	require.True(t, marked)
	require.Equal(t, []string{"Architecture", "API"}, got.Tags)
}

func TestParseDocument_RejectsEmptyTag(t *testing.T) {
	t.Parallel()

	source := []byte(`---
title: Code quality
notion:
  rootPageID: 195de9221179449fab8075a27c979105
  owners: [andreas]
  tags:
    - Architecture
    - " "
---
`)

	_, _, err := parseDocument("docs/engineering/code-quality.mdx", source)
	require.EqualError(t, err, "marked document docs/engineering/code-quality.mdx has an empty Notion tag")
}

func TestParseDocument_RequiresOwner(t *testing.T) {
	t.Parallel()

	source := []byte(`---
title: Code quality
notion:
  rootPageID: 195de9221179449fab8075a27c979105
---
`)

	_, _, err := parseDocument("docs/engineering/code-quality.mdx", source)
	require.EqualError(t, err, "marked document docs/engineering/code-quality.mdx has no Notion owner")
}

func TestParseDocument_RejectsRelativePathForWiki(t *testing.T) {
	t.Parallel()

	source := []byte(`---
title: Code quality
notion:
  rootPageID: 195de9221179449fab8075a27c979105
  relativePath: contributing/quality
  owners: [andreas]
---
`)

	_, _, err := parseDocument("docs/engineering/code-quality.mdx", source)
	require.EqualError(t, err, "marked document docs/engineering/code-quality.mdx has a relativePath, which Notion wiki pages do not support")
}
