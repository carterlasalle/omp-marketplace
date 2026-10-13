# OMP OpenRouter Provider Switcher

An OMP extension for changing the **upstream inference provider** behind the currently selected OpenRouter model without changing the model itself.

Example:

```text
openrouter/z-ai/glm-5.3
        ↓
/or-provider cloudflare
        ↓
openrouter/z-ai/glm-5.3 @ Cloudflare
```

Internally this uses OMP's OpenRouter upstream-routing support (`provider.only`) rather than creating fake model/provider entries.

## Install

Via the marketplace:

```text
/marketplace add carterlasalle/omp-marketplace
/marketplace install openrouter-provider-switcher@carter-omp-marketplace
```

Or link for local development:

```bash
omp plugin link ./plugins/openrouter-provider-switcher
```

Restart OMP after install — extension modules load at startup.

No dependency install is required because the extension has no runtime dependencies outside OMP itself.

## Usage

Interactive picker using OpenRouter's live endpoint catalog:

```text
/or-provider
```

Short alias:

```text
/orp
```

Direct selection:

```text
/or-provider cloudflare
/or-provider cerebras
/or-provider fireworks
```

Return to OpenRouter's automatic provider routing:

```text
/or-provider auto
```

Show the current pin:

```text
/or-provider status
```

Force-refresh the live provider list and reopen the picker:

```text
/or-provider refresh
```

The status bar shows:

```text
OR→cloudflare
```

or:

```text
OR→auto
```

## Picker data

The extension queries OpenRouter's current per-model endpoint API and displays available providers along with whatever live metrics OpenRouter returns, including p50 throughput, p50 latency, uptime, token pricing, and quantization.

The endpoint list is cached for 60 seconds per model.

## Requirements

- A current OMP build with extension `ctx.models.resolve()` / `pi.setModel()` support and OpenRouter `@upstream` routing.
- OpenRouter credentials already available to OMP through your normal login/config/environment setup.
- The active model must be under the `openrouter` provider.

## Important

If you previously installed an extension that **overrides/re-registers the entire `openrouter` provider** as a generic OpenAI-compatible provider, disable/remove that extension. This switcher expects OMP's native OpenRouter transport because that transport serializes the upstream route into OpenRouter's `provider.only` request object.
