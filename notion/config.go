package main

import (
	"fmt"
	"os"

	"go.yaml.in/yaml/v3"
)

// rootConfig identifies one managed wiki.
type rootConfig struct {
	PageID string `yaml:"pageID"`
}

// rootRegistry is the on-disk list of wikis managed during cleanup.
type rootRegistry struct {
	Roots []rootConfig `yaml:"roots"`
}

// loadRootRegistry reads and validates the root registry at path.
func loadRootRegistry(path string) ([]rootConfig, error) {
	source, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read Notion root registry: %w", err)
	}
	return parseRootRegistry(source)
}

// parseRootRegistry normalizes page UUIDs for API requests.
func parseRootRegistry(source []byte) ([]rootConfig, error) {
	var registry rootRegistry
	if err := yaml.Unmarshal(source, &registry); err != nil {
		return nil, fmt.Errorf("parse Notion root registry: %w", err)
	}
	if len(registry.Roots) == 0 {
		return nil, fmt.Errorf("Notion root registry has no roots")
	}
	roots := make([]rootConfig, len(registry.Roots))
	seen := map[string]struct{}{}
	for i, configured := range registry.Roots {
		rootID, err := parseRootPageID(configured.PageID)
		if err != nil {
			return nil, fmt.Errorf("invalid Notion root %q: %w", configured.PageID, err)
		}
		if _, ok := seen[rootID]; ok {
			return nil, fmt.Errorf("Notion root %s is configured more than once", rootID)
		}
		seen[rootID] = struct{}{}
		roots[i] = rootConfig{PageID: rootID}
	}
	return roots, nil
}
