# Configuration

This directory contains the official OpenCode config templates for `oc-codex-multi-auth` v6.9.1.

## Required: choose the right config file

| File | OpenCode version | Description |
|------|------------------|-------------|
| [`opencode-modern.json`](./opencode-modern.json) | **v1.0.210+** | Variant-based config: **12 base models**, **53 variants** total |
| [`opencode-legacy.json`](./opencode-legacy.json) | **v1.0.209 and below** | Legacy explicit entries: **53** individual model definitions |

## Install modes

| Installer flag | What gets written |
|----------------|-------------------|
| default / `--plugin-only` | Register plugin entries; preserve `provider.openai` |
| `--modern` | Compact modern: 12 base OAuth families + variant picker |
| `--full` | Modern bases **plus** explicit legacy selector IDs |
| `--legacy` | Explicit-only catalog (53 preset model entries) |

```bash
npx -y oc-codex-multi-auth@latest          # plugin entries only
npx -y oc-codex-multi-auth@latest --modern # compact modern catalog
npx -y oc-codex-multi-auth@latest --full   # modern + explicit IDs
npx -y oc-codex-multi-auth@latest --legacy # explicit only
```

Run the installer with `--modern` to remove explicit preset IDs and stale base models left by earlier plugin catalogs.

## Quick pick

If your OpenCode version is v1.0.210 or newer:

```bash
cp config/opencode-modern.json ~/.config/opencode/opencode.json
```

If your OpenCode version is v1.0.209 or older:

```bash
cp config/opencode-legacy.json ~/.config/opencode/opencode.json
```

Check your version with:

```bash
opencode --version
```

## Why there are two templates

OpenCode v1.0.210+ added model `variants`, so one model entry can expose multiple reasoning levels. That keeps modern config smaller while preserving the same effective presets.

Both templates include:

### Base model families (12)

| Base | Variants (modern) |
|------|-------------------|
| `gpt-5.6-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-terra` | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-luna` | low, medium, high, xhigh, max |
| `gpt-5.5` | none, low, medium, high, xhigh |
| `gpt-5.5-fast` | none, low, medium, high, xhigh |
| `gpt-5.4-mini` | none, low, medium, high, xhigh |
| `gpt-5.4-nano` | none, low, medium, high, xhigh |
| `gpt-5.1-codex-max` | low, medium, high, xhigh |
| `gpt-5.1-codex` | low, medium, high |
| `gpt-5.1-codex-mini` | medium, high |
| `gpt-5.1` | none, low, medium, high |
| `gpt-5-codex` | low, medium, high |

Shared template requirements:

- `store: false` and `include: ["reasoning.encrypted_content"]`
- Context metadata:
  - `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` / `gpt-5.5` / `gpt-5.5-fast`: context **1,050,000**, output **128,000**
  - `gpt-5.4-mini` / `gpt-5.4-nano` / Codex models (`gpt-5-codex`, `gpt-5.1-codex*`, …): context **400,000**, output **128,000**
  - `gpt-5.1`: context **272,000**, output **128,000**

Use `opencode debug config` to verify that these template entries were merged into your effective config. The default compact install shows base OAuth entries such as `gpt-5.5` / `gpt-5.6-sol`; the separate OpenCode variant picker exposes the reasoning presets.

If your OpenCode runtime supports global compaction tuning, you can also set values near the largest context windows (for example ~1M context / slightly lower auto-compact limit). Prefer values that match your selected model family.

## GPT-5.6 notes

- Served over the **responses-lite** path (`use_responses_lite`).
- Preview entitlement: accounts without access auto-fallback  
  `gpt-5.6-sol → gpt-5.6-terra → gpt-5.6-luna → gpt-5.5`  
  (disable with `CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK=1`).
- Default client identity for 5.6 is host/opencode (`originator: opencode`); other families default to Codex CLI identity.
- `ultra` is accepted as a client-side alias and sent as `max` on the wire (no subagent orchestration in this plugin).

## Spark model note

The templates intentionally do **not** include `gpt-5.3-codex-spark` by default. Spark is often entitlement-gated at the account/workspace level, so shipping it by default causes avoidable startup failures for many users.

If your workspace is entitled, you can add Spark model IDs manually.

## Usage examples

Recommended compact UI selectors:

```bash
opencode run "task" --model=openai/gpt-5.5 --variant=medium
opencode run "task" --model=openai/gpt-5.5-fast --variant=medium
opencode run "task" --model=openai/gpt-5.6-sol --variant=medium
opencode run "task" --model=openai/gpt-5-codex --variant=high
```

If you need direct explicit selector IDs for scripts, install with:

```bash
npx -y oc-codex-multi-auth@latest --full
```

## Minimal config (advanced)

A barebones debug template is available at [`minimal-opencode.json`](./minimal-opencode.json). It omits the full preset catalog.

## Unsupported-model behavior

Current defaults are strict entitlement handling except for common default-selector entitlement gates:

- **GPT-5.6** auto-fallback: `gpt-5.6-sol → gpt-5.6-terra → gpt-5.6-luna → gpt-5.5`
- **`gpt-5.5`** and canonical **`gpt-5-codex`** can auto-fallback through `gpt-5.4`, `gpt-5.4-mini`, then `gpt-5.4-nano` when the backend reports the selected model is not supported
- `unsupportedCodexPolicy: "strict"` returns other entitlement errors directly
- set `unsupportedCodexPolicy: "fallback"` (or `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY=fallback`) to enable the full fallback chain for manual/legacy selectors
- `fallbackToGpt52OnUnsupportedGpt53: true` keeps the legacy `gpt-5.3-codex -> gpt-5.2-codex` edge inside fallback mode
- user-typed `gpt-5.5-pro*` is canonicalized to `gpt-5.5` before fallback because GPT-5.5 Pro is ChatGPT-only, not a Codex-routable model
- legacy Codex selectors such as `gpt-5.2-codex`, `gpt-5.3-codex`, and `gpt-5.3-codex-spark` normalize to canonical `gpt-5-codex`; if that canonical Codex model is gated, the default auto-fallback can retry through the GPT-5.4 family
- set `CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK=1` to disable GPT-5.6 auto-fallback
- set `CODEX_AUTH_DISABLE_GPT55_AUTO_FALLBACK=1` to disable GPT-5.5 auto-fallback
- set `CODEX_AUTH_DISABLE_CODEX_AUTO_FALLBACK=1` to disable canonical Codex/GPT-5.4-family auto-fallback
- `gpt-5.4-pro -> gpt-5.4` remains available for older manual configs
- `unsupportedCodexFallbackChain` lets you override fallback order per model

Default chains when generic fallback policy is enabled (and empty override map):

- `gpt-5.6-sol → gpt-5.6-terra → gpt-5.6-luna → gpt-5.5` (also auto under default strict for preview gates)
- `gpt-5.5 → gpt-5.4 → gpt-5.4-mini → gpt-5.4-nano`
- `gpt-5-codex → gpt-5.4 → gpt-5.4-mini → gpt-5.4-nano`
- `gpt-5.4-pro → gpt-5.4` (if you manually select `gpt-5.4-pro`)
- `gpt-5.3-codex → gpt-5-codex → gpt-5.2-codex`
- `gpt-5.3-codex-spark → gpt-5-codex → gpt-5.3-codex → gpt-5.2-codex` (only if Spark IDs are added manually)
- `gpt-5.2-codex → gpt-5-codex`
- `gpt-5.1-codex → gpt-5-codex`

## Additional docs

- Main config reference: [`docs/configuration.md`](../docs/configuration.md)
- Getting started: [`docs/getting-started.md`](../docs/getting-started.md)
- Tools and CLI: [`docs/tools-and-cli.md`](../docs/tools-and-cli.md)
- Troubleshooting: [`docs/troubleshooting.md`](../docs/troubleshooting.md)
