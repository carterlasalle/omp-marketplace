# carter-omp-marketplace

Personal [oh-my-pi](https://omp.sh) plugin marketplace.

## Add the marketplace

```
/marketplace add carterlasalle/omp-marketplace
```

CLI equivalent:

```
omp plugin marketplace add carterlasalle/omp-marketplace
```

## Plugins

| Plugin | Description |
| --- | --- |
| [openrouter-provider-switcher](plugins/openrouter-provider-switcher) | Switch the upstream inference provider for the current OpenRouter model (`/or-provider`, `/orp`) with a live metrics picker. |
| [post-lsp-ci-fix](plugins/post-lsp-ci-fix) | Hidden "fix the root cause" reminder whenever LSP diagnostics arrive — inline, late, or explicit. |

Install one with:

```
/marketplace install <name>@carter-omp-marketplace
```

Restart OMP after installing — extension modules load at startup.

## Updates

With `marketplace.autoUpdate: auto` in `~/.omp/agent/config.yml`, OMP checks for updates at startup. Or upgrade manually:

```
/marketplace upgrade <name>@carter-omp-marketplace
```

## Local development

Link a plugin working copy so edits load directly (restart OMP after edits):

```
omp plugin link ./plugins/<name>
```

## License

MIT
