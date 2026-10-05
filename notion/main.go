package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
)

// commandConfig contains validated action inputs and their local equivalents.
type commandConfig struct {
	Token        string
	RegistryPath string
}

// main runs the sync until completion or an interrupt signal.
func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	if err := run(ctx); err != nil {
		if _, writeErr := fmt.Fprintln(os.Stderr, err); writeErr != nil {
			os.Exit(2)
		}
		os.Exit(1)
	}
}

// run validates configuration, discovers marked tracked files, and syncs them.
func run(ctx context.Context) error {
	repositoryRoot, paths, err := trackedMarkdownFiles(ctx)
	if err != nil {
		return err
	}
	config, err := loadCommandConfig(repositoryRoot, os.Args[1:])
	if err != nil {
		return err
	}
	roots, err := loadRootRegistry(config.RegistryPath)
	if err != nil {
		return err
	}
	documents := make([]document, 0, len(paths))
	for _, path := range paths {
		source, err := os.ReadFile(filepath.Join(repositoryRoot, filepath.FromSlash(path)))
		if err != nil {
			return fmt.Errorf("read %s: %w", path, err)
		}
		document, marked, err := parseDocument(path, source)
		if err != nil {
			return err
		}
		if marked {
			documents = append(documents, document)
		}
	}

	onSynced := func(document document) error {
		_, err := fmt.Fprintf(os.Stdout, "Synced %s as %q.\n", document.SourcePath, document.Title)
		return err
	}
	client := newNotionClient(config.Token)
	rootIDs := make([]string, len(roots))
	for i, root := range roots {
		if err := client.prepareRoot(ctx, root.PageID); err != nil {
			return fmt.Errorf("prepare Notion root %s: %w", root.PageID, err)
		}
		if err := client.organizeRoot(ctx, root.PageID, root.ViewID); err != nil {
			return fmt.Errorf("organize Notion root %s: %w", root.PageID, err)
		}
		rootIDs[i] = root.PageID
	}
	if err := syncDocumentsForRoots(ctx, client, documents, rootIDs, onSynced); err != nil {
		return err
	}
	_, err = fmt.Fprintf(os.Stdout, "Synced %d Notion documents.\n", len(documents))
	return err
}

// loadCommandConfig resolves GitHub Action inputs while retaining a local
// environment-variable interface for development.
func loadCommandConfig(repositoryRoot string, args []string) (commandConfig, error) {
	if len(args) > 1 {
		return commandConfig{}, fmt.Errorf("expected at most one config path argument")
	}
	token := strings.TrimSpace(os.Getenv("NOTION_TOKEN"))
	registryPath := ""
	if len(args) == 1 {
		registryPath = strings.TrimSpace(args[0])
	}
	if token == "" {
		return commandConfig{}, fmt.Errorf("Notion token is required")
	}
	if registryPath == "" {
		registryPath = filepath.Join(".github", "notion.yaml")
	}
	if !filepath.IsAbs(registryPath) {
		registryPath = filepath.Join(repositoryRoot, registryPath)
	}
	return commandConfig{Token: token, RegistryPath: filepath.Clean(registryPath)}, nil
}

// trackedMarkdownFiles returns repository-relative paths for tracked Markdown
// files only. Ignoring untracked files keeps local drafts out of a manual
// CI-equivalent run.
func trackedMarkdownFiles(ctx context.Context) (string, []string, error) {
	rootCommand := exec.CommandContext(ctx, "git", "-c", "safe.directory=*", "rev-parse", "--show-toplevel")
	rootOutput, err := rootCommand.CombinedOutput()
	if err != nil {
		return "", nil, fmt.Errorf("find repository root: %w: %s", err, bytes.TrimSpace(rootOutput))
	}
	repositoryRoot := strings.TrimSpace(string(rootOutput))

	filesCommand := exec.CommandContext(ctx, "git", "-c", "safe.directory=*", "-C", repositoryRoot, "ls-files", "-z", "--", "*.md", "*.mdx")
	filesOutput, err := filesCommand.CombinedOutput()
	if err != nil {
		return "", nil, fmt.Errorf("list tracked Markdown files: %w: %s", err, bytes.TrimSpace(filesOutput))
	}
	paths := []string{}
	for _, path := range bytes.Split(filesOutput, []byte{0}) {
		if len(path) > 0 {
			paths = append(paths, string(path))
		}
	}
	return repositoryRoot, paths, nil
}
