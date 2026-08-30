---
status: accepted
---

# The plugin registers Servers and validates routing; it never assigns models to agents

gentle-pi already owns per-agent model routing (`/gentle:models`, a global file with a flat, unversioned map that silently drops unknown keys and exposes no write API), and its picker already lists custom local providers through Pi's model registry. Building our own assignment flow would duplicate that picker, race it for ownership of the same file, and make an upstream contribution unlikely. We decided the plugin has exactly two responsibilities: register local Servers as Pi Providers so they appear in `/gentle:models`, and validate the routing gentle-pi saved (capability probes, context thresholds), warning the user — reading gentle-pi's file, never writing it.

## Consequences

- The user runs three steps (`/local-models` → `/gentle:models` → `/local-models check`) instead of one; the PRD's "single flow" goal is dropped.
- Zero-regression on gentle-pi files holds by construction.
- Any future upstream PR to gentle-pi is a validation hook, not a competing UI.
- Named profiles (PRD R6) are dropped. Team-shared routing (PRD R7) lives in gentle-pi's own versioned export envelope committed to the repo; the plugin can validate such an export before it is restored, but never applies it.
