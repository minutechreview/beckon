// Package integrations embeds the hook configs and plugin in this directory,
// so "beckon setup" installs exactly the files docs/agents.md points to.
package integrations

import "embed"

//go:embed claude/settings.json codex/hooks.json copilot/beckon.json cursor/hooks.json gemini/settings.json opencode/beckon.js
var Files embed.FS
