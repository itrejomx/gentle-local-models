# Published: https://github.com/Gentleman-Programming/gentle-pi/issues/510

**Title:** `bug(models): "Set all agents" persists template placeholder names as routing entries`

**Labels expected:** bug, status:needs-review

---

### Bug Description

The `/gentle:models` panel's "Set all agents" action writes a routing entry for every
discoverable agent. Agent discovery (`listDiscoverableAgents`, `extensions/gentle-ai.ts:1488-1503`)
parses the frontmatter `name:` of every `.md` file in the agent directories
(`parseAgentName`, `:1362-1375`), including scaffolding/template files whose `name:` is a
literal placeholder. Those placeholder names end up persisted in `~/.pi/gentle-ai/models.json`.

Real examples from our file (517 entries total after one sweep):

```
{module-code-or-empty}agent-{agent-name}
{module-code-or-empty}{skill-name}
{setup-skill-name}
```

These keys contain braces, so they fail the key pattern `/^[A-Za-z0-9._:@/+%-]+$/` (`:1280`)
and `applyModelConfig` silently skips them (`:1723-1726`). They never apply, never error,
and nothing cleans them — dead weight that accumulates in the routing file on every sweep.

### Steps to Reproduce

1. Have a project whose `.agents/` or `.pi/agents/` contains template `.md` files with a
   literal placeholder in frontmatter, e.g. `name: {module-code-or-empty}{skill-name}`
   (BMAD-style scaffolding does this).
2. Open `/gentle:models`.
3. Select row 0 "Set all agents", pick any model, save with `ctrl+s`.
4. Inspect `~/.pi/gentle-ai/models.json`.

### Expected Behavior

Only real routable agents get entries. Names that fail the safe-key pattern (or contain
`{`/`}`) are excluded from discovery — or at minimum refused at write time with a message.

### Actual Behavior

Placeholder names are persisted as routing entries. Apply silently skips them, so the file
grows garbage with no feedback to the user.

### Suggested Fix

Filter at the single choke point: skip files whose parsed `name` fails
`/^[A-Za-z0-9._:@/+%-]+$/` in `listDiscoverableAgents` / `parseAgentName`. Optionally also
validate keys in `writeModelConfig` and surface skipped entries in `gentle:doctor`.

### Context

- gentle-pi 2.2.0, Pi 0.84.2, macOS (zsh), Claude Code / Pi.
- Found while building an external local-models configurator that reads the routing file.
- Related: #381 (machine-readable routing contract) — its validation slice will need to
  reject these same names, so filtering discovery now shrinks that surface.
