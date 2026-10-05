package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLoadCommandConfig_UsesActionInputs(t *testing.T) {
	t.Setenv("NOTION_TOKEN", "local-token")

	got, err := loadCommandConfig("/workspace", []string{"config/notion.yaml"})
	require.NoError(t, err)
	require.Equal(t, commandConfig{
		Token:        "local-token",
		RegistryPath: "/workspace/config/notion.yaml",
	}, got)
}

func TestTrackedMarkdownFiles_ReturnsTrackedMarkdownAndMDXFiles(t *testing.T) {
	repositoryRoot := t.TempDir()
	writeTestFile(t, repositoryRoot, "guide.md")
	writeTestFile(t, repositoryRoot, "reference.mdx")
	writeTestFile(t, repositoryRoot, "notes.txt")
	writeTestFile(t, repositoryRoot, "draft.md")
	runGit(t, repositoryRoot, "init")
	runGit(t, repositoryRoot, "add", "guide.md", "reference.mdx", "notes.txt")
	t.Chdir(repositoryRoot)

	root, paths, err := trackedMarkdownFiles(context.Background())
	require.NoError(t, err)
	require.Equal(t, repositoryRoot, root)
	require.Equal(t, []string{"guide.md", "reference.mdx"}, paths)
}

func writeTestFile(t *testing.T, root, path string) {
	t.Helper()
	require.NoError(t, os.WriteFile(filepath.Join(root, path), []byte("# Test\n"), 0o600))
}

func runGit(t *testing.T, root string, args ...string) {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", root}, args...)...)
	output, err := command.CombinedOutput()
	require.NoError(t, err, string(output))
}
