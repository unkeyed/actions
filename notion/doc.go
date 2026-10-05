// Package main synchronizes repository-owned Markdown documents into Notion.
//
// Git remains the source of truth. The command selects documents through
// frontmatter, publishes them as direct wiki entries, and uses page metadata to
// preserve identity and remove pages whose source files no longer exist.
package main
