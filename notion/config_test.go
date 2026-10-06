package main

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParseRootRegistry_NormalizesWikiIDs(t *testing.T) {
	t.Parallel()

	got, err := parseRootRegistry([]byte(`roots:
  - pageID: 3ee512d6-43f3-8063-b525-d6c3619c1f69
`))
	require.NoError(t, err)
	require.Equal(t, []rootConfig{{
		PageID: "3ee512d643f38063b525d6c3619c1f69",
	}}, got)
}
