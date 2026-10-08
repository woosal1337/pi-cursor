# pi-cursor-auth

> [!NOTE]
> This is a fork of [morizkay/pi-cursor-auth](https://github.com/morizkay/pi-cursor-auth). Its `main` branch adds fixes that are not in an npm release yet. The [changelog](CHANGELOG.md) lists them under "Unreleased".
>
> To use this fork, remove the npm package first, because both packages register the `cursor` provider:
>
> ```bash
> pi remove npm:pi-cursor-auth
> pi install git:github.com/woosal1337/pi-cursor
> ```

A [pi](https://pi.dev) extension that registers **Cursor** as a pi model provider, using your [Cursor SDK](https://cursor.com) API key.

Pi owns the agent loop, tools, and extensions (`pi-lens`, ponytail, hermes-memory, and the rest). Cursor is the model: this plugin streams thinking, text, and tool calls back into pi.

See the [changelog](https://github.com/morizkay/pi-cursor-auth/blob/main/CHANGELOG.md) for release notes. Contributor notes are in [AGENTS.md](https://github.com/morizkay/pi-cursor-auth/blob/main/AGENTS.md).

## Install

Requires [pi](https://pi.dev). Then:

```bash
pi install npm:pi-cursor-auth
```

Pin a version if you want updates to skip this package:

```bash
pi install npm:pi-cursor-auth@0.2.3
```

Installs are written to `~/.pi/agent/settings.json`. Use `-l` to install for the current project (`.pi/settings.json`) instead.

Only one `cursor` provider should be installed. Uninstall any other Cursor provider first.

## Uninstall

```bash
pi uninstall npm:pi-cursor-auth
```

Use `-l` if the package was installed in the project.

## Configure your Cursor API key

Choose one:

1. **Environment variable** (set it before starting pi):

   ```bash
   export CURSOR_API_KEY="crsr_..."
   pi
   ```

2. **`/login`** — in pi, run `/login`, choose *Use an API key*, choose *Cursor*, and paste the key. pi stores it in `~/.pi/agent/auth.json`.

3. **`/cursor-auth`** — run `/cursor-auth` and paste your key, or pass it as an argument: `/cursor-auth crsr_...`. Writes the key to `~/.pi/agent/auth.json` under the `cursor` entry.

If pi started without a key, run **`/cursor-refresh-models`** after `/login` or `/cursor-auth` so the extension loads the live Cursor catalog. The startup fallback list is small.

## Use

Pick a Cursor model with `/model` (or Ctrl+L), for example:

- `cursor/default`
- `cursor/claude-opus-5`
- `cursor/gpt-5.6-sol`

You can also start pi with a model:

```bash
pi --model cursor/default
```

To save Cursor as the startup default, select it in `/model` and press **Ctrl+S**. That writes `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "cursor",
  "defaultModel": "default"
}
```

Unknown model ids, including `auto-smart`, are mapped to `cursor/default`.

## Commands

- `/cursor-auth [key]` — store your Cursor API key
- `/cursor-refresh-models` — re-discover the live Cursor catalog with the current key

## How it works

The extension registers a complete pi `Provider` via `createProvider()`. It also mirrors its streams into pi-ai's compatibility registry so extensions that use legacy `completeSimple()` calls (such as Hermes Memory) can use the active Cursor provider. On each turn it:

1. Uses pi `/login` (or `CURSOR_API_KEY` / `/cursor-auth`) for the Cursor API key
2. Sends **pi's** system prompt, conversation, and tools (pi-lens, builtins, and the rest) to a Cursor model
3. Keeps Cursor's built-in file/shell tools off. Model tool calls come back to pi as `toolCall` events so **pi** executes them and continues the loop
4. Configures the SDK's bundled ripgrep binary when the host PATH does not expose it, so workspace ignore scanning remains quiet and functional

## Limitations

- Each pi model round-trip creates a fresh Cursor agent with `tools: []` (or MCP-only for pi tools). Cursor does not keep its own tool loop or session memory.
- Model context windows and costs are not available per-model from the SDK catalog, so costs show as $0 in usage. Token counts are accurate.

## Development

Clone, install, and see [AGENTS.md](https://github.com/morizkay/pi-cursor-auth/blob/main/AGENTS.md) for layout, commands, and contribution rules.

```bash
git clone https://github.com/morizkay/pi-cursor-auth.git
cd pi-cursor-auth
npm install
```

```bash
export CURSOR_API_KEY="crsr_..."
npm test                 # unit + live integration (real Cursor call)
npm run check            # tsc --noEmit
```

The live test calls Cursor with your key and asserts a streamed response with token usage. It is skipped when `CURSOR_API_KEY` is unset.

For a local pi install from a checkout:

```bash
pi install ./
```
