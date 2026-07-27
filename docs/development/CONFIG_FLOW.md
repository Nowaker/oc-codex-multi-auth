# OpenCode Config Flow

This document describes the current config surfaces used by `oc-codex-multi-auth` on `main`.

## Primary Config Surfaces

### Global OpenCode config

The installer writes and updates:

```text
~/.config/opencode/opencode.json
```

That file is the primary global config surface used by the shipped install flow in this repository.

### Project override

Project-specific overrides can live in:

```text
<project>/.opencode.json
```

Use that when you want per-project model or provider overrides without changing the global install.

### One-shot overrides

OpenCode can also accept override content at process start:

```bash
OPENCODE_CONFIG=/path/to/config.json opencode
OPENCODE_CONFIG_CONTENT='{"model":"openai/gpt-5.5","variant":"medium"}' opencode
```

### Plugin runtime config

Plugin-specific runtime settings live outside the OpenCode config file:

```text
~/.opencode/openai-codex-auth-config.json
```

That file controls plugin behavior such as retry policy, rotation strategy, beginner safe mode, fallback policy, TUI output, model account pools, and per-project account storage. Schema and defaults live in `lib/schemas.ts` and `lib/config.ts`. Boolean environment overrides are truthy only for the literal string `"1"`.

## Installer Flow

`scripts/install-oc-codex-multi-auth.js` performs these steps:

1. Load the selected template set:
   - default / `--plugin-only`: preserve `provider.openai`
   - `--modern`: `config/opencode-modern.json` (compact 12 bases / 53 variants)
   - `--full`: modern bases merged with `config/opencode-legacy.json` explicit entries
   - `--legacy`: `config/opencode-legacy.json` only (53 explicit IDs)
2. Back up an existing `~/.config/opencode/opencode.json` only when the merged result changes.
3. Normalize the plugin list so it ends with plain `oc-codex-multi-auth`.
4. Merge `provider.openai` with the selected shipped template block; `--plugin-only` skips this step entirely.
5. Enable the TUI plugin in `~/.config/opencode/tui.json`.
6. Clear the cached OpenCode plugin copy under `~/.cache/opencode/` unless `--no-cache-clear`.

Additional flags:

| Flag | Effect |
|------|--------|
| `--dry-run` | Print changed config paths without values or writes |
| `--no-cache-clear` | Skip OpenCode plugin cache cleanup |
| `--plugin-only` | Explicit alias for default plugin/TUI registration without changing `provider.openai` |
| `update [--dry-run]` | Clear managed package caches without reading or writing OpenCode config |
| standalone first arg | Run CLI without install: `doctor`, `status`, `list`, `limits`, `dashboard`, `health`, `diag`, `warm` |

Important detail:

- The installer intentionally writes the plugin entry as `oc-codex-multi-auth`, not `oc-codex-multi-auth@latest`.
- The default install mode only manages plugin entries; catalog installation is explicit.
- `--modern` uses the compact base-model template so the TUI model picker shows real OAuth model families and leaves reasoning depth to the variant picker.
- `--full` merges the modern base-model template with the explicit legacy preset entries for scripts that require direct selector IDs.
- `update` returns before template loading and config parsing, so even malformed user config is left untouched.

## Shipped Template Structure

### Modern template

`config/opencode-modern.json` is the compact variant-based template for OpenCode `v1.0.210+`.

It currently ships:

- 12 base model families
- 53 total variants
- GPT-5.6 Sol / Terra / Luna (responses-lite path)
- `gpt-5.5` and `gpt-5.5-fast` at 1,050,000 context / 128,000 output
- GPT-5.6 tiers at 1,050,000 context / 128,000 output
- `gpt-5.4-mini`, `gpt-5.4-nano`, and Codex families at 400,000 context / 128,000 output
- `gpt-5.1` at 272,000 context / 128,000 output
- `store: false` plus `include: ["reasoning.encrypted_content"]`

Base families:

```text
gpt-5.6-sol
gpt-5.6-terra
gpt-5.6-luna
gpt-5.5
gpt-5.5-fast
gpt-5.4-mini
gpt-5.4-nano
gpt-5.1-codex-max
gpt-5.1-codex
gpt-5.1-codex-mini
gpt-5.1
gpt-5-codex
```

### Default installer mode

The default installer mode writes only:

- the `oc-codex-multi-auth` entry in OpenCode's plugin list
- the `oc-codex-multi-auth` entry in the TUI plugin list

It preserves `provider.openai` exactly.

### Modern installer mode

`--modern` writes the 12 modern base model entries from `config/opencode-modern.json`. Reasoning presets are selected through the separate variant picker.

Example shape:

```json
{
  "plugin": ["oc-codex-multi-auth"],
  "provider": {
    "openai": {
      "options": {
        "reasoningEffort": "medium",
        "reasoningSummary": "auto",
        "textVerbosity": "medium",
        "include": ["reasoning.encrypted_content"],
        "store": false
      },
      "models": {
        "gpt-5.5": {
          "name": "GPT 5.5 (OAuth)",
          "variants": {
            "medium": { "reasoningEffort": "medium" },
            "high": { "reasoningEffort": "high" }
          }
        },
        "gpt-5.6-sol": {
          "name": "GPT 5.6 Sol (OAuth)",
          "variants": {
            "medium": { "reasoningEffort": "medium" },
            "high": { "reasoningEffort": "high" }
          }
        }
      }
    }
  }
}
```

Modern install uses base model IDs plus variants:

```bash
opencode run "task" --model=openai/gpt-5.5 --variant=medium
opencode run "task" --model=openai/gpt-5.5-fast --variant=medium
opencode run "task" --model=openai/gpt-5.6-sol --variant=high
```

### Full installer mode

`--full` combines:

- the 12 modern base model entries from `config/opencode-modern.json`
- the 53 explicit preset entries from `config/opencode-legacy.json`

Use it when scripts require direct selector IDs:

```bash
npx -y oc-codex-multi-auth@latest --full
opencode run "task" --model=openai/gpt-5.5-medium
opencode run "task" --model=openai/gpt-5.5-fast-medium
opencode run "task" --model=openai/gpt-5.6-sol-high
```

### Legacy template

`config/opencode-legacy.json` is for OpenCode `v1.0.209` and earlier.

It currently ships:

- 53 explicit model entries
- separate model IDs such as `gpt-5.5-medium`, `gpt-5.5-fast-medium`, `gpt-5.5-high`, `gpt-5.6-sol-xhigh`, and `gpt-5.4-mini-xhigh`
- the same OpenAI provider defaults (`store: false`, `reasoning.encrypted_content`)

Legacy OpenCode selection uses:

```bash
opencode run "task" --model=openai/gpt-5.5-high
```

## Runtime Resolution

At runtime, OpenCode passes `provider.openai.options` and `provider.openai.models` into the plugin loader. The plugin then:

1. Reads global provider options.
2. Reads per-model definitions.
3. Applies request-shaping behavior (`native` by default, `legacy` when explicitly enabled).
4. Normalizes selected model IDs to canonical upstream Codex/ChatGPT model families before the final API call.
5. For GPT-5.6 Sol/Terra/Luna, applies the responses-lite request shape and default `opencode` client identity.
6. Resolves preferred accounts via `modelAccountPools`, then selects an account with `rotationStrategy`.

Examples:

- `openai/gpt-5.5` with variant `medium` normalizes to `gpt-5.5`
- `openai/gpt-5.6-sol` with variant `high` normalizes to `gpt-5.6-sol`
- `openai/gpt-5.6-sol-xhigh` normalizes to `gpt-5.6-sol`
- `openai/gpt-5.4-mini-xhigh` normalizes to `gpt-5.4-mini`
- legacy aliases such as `gpt-5-mini` normalize to `gpt-5.4-mini`
- bare `gpt-5.6` normalizes to flagship tier `gpt-5.6-sol`

## Verification

Use these commands when checking the effective config:

```bash
opencode debug config
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "ping" --model=openai/gpt-5.5 --variant=medium
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "ping" --model=openai/gpt-5.6-sol --variant=medium
```

Important runtime behavior:

- `opencode debug config` shows merged provider models from your config.
- `--modern` shows compact OAuth base entries such as `gpt-5.5`, `gpt-5.5-fast`, and `gpt-5.6-sol`.
- `--full` additionally shows explicit entries such as `gpt-5.5-medium` / `gpt-5.5-fast-medium` / `gpt-5.6-sol-high`.
- Compact verification should use `--model=openai/gpt-5.5 --variant=medium`, not `gpt-5.5-medium`, unless `--full` or `--legacy` was installed.

## File Locations

| Path | Purpose |
|------|---------|
| `~/.config/opencode/opencode.json` | global OpenCode config used by the installer |
| `~/.config/opencode/tui.json` | OpenCode TUI plugin config |
| `<project>/.opencode.json` | project-local OpenCode override |
| `~/.opencode/openai-codex-auth-config.json` | plugin runtime config |
| `~/.opencode/auth/openai.json` | OAuth token storage |
| `~/.opencode/oc-codex-multi-auth-accounts.json` | global account storage |
| `~/.opencode/projects/<project-key>/oc-codex-multi-auth-accounts.json` | per-project account storage |
| `~/.opencode/logs/codex-plugin/` | plugin request/debug logs |

## See Also

- [CONFIG_FIELDS.md](./CONFIG_FIELDS.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [../../config/README.md](../../config/README.md)
