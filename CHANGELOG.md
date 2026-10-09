# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A `-fast` copy of each model that offers Cursor's Fast mode, such as `cursor/grok-4.7-fast`. The copy sends `fast=true`.

### Changed

- Send `fast=false` and the smallest context option on every request. Before, Cursor used the default variant of each model, which turned Fast on for Grok and picked the 500k context for `grok-4.7`.
- Set the context window from the context option that the bridge sends, such as 256,000 tokens for `grok-4.7`. Models without a context option keep 200,000 tokens.

### Fixed

- Declare `xhigh` and `max` in the `thinkingLevelMap` of each Cursor model when the live catalog offers them. Before this fix, pi hid both levels, and `cursor/grok-4.7` stopped at `high`.
- Read the system prompt and tools from pi's transcript system messages. Since pi 0.86, providers get a `TranscriptContext` without `context.systemPrompt` or `context.tools`, so Cursor ran with no pi tools and no system prompt.
- Estimate usage for a turn that hands a tool call to pi. Cursor reports usage only when a run ends, so these turns had zero usage, and context gauges such as `pi-minimal-footer` showed an empty context. The estimate adds Cursor's own agent prompt and ignores usage from before a compaction.
- Count Cursor's cached input tokens once. Cursor's `inputTokens` include `cacheReadTokens`, so pi showed too many tokens when Cursor used its cache.
- Keep a cached model id, such as `grok-4.7`, until the live catalog loads. pi print mode never loads it, and interactive mode loads it a short time after start-up. Before this fix, such ids mapped to `default`, so Cursor ran its Auto model.
- Record the usage of one model call. Cursor reports the sum of all model calls in a run, and the first tool use adds a hidden call that loads the tool schemas. A Grok turn with two calls of about 151,000 tokens showed 304,372 tokens, so pi compacted the chat at 59% of the context window.
- Estimate a tool-call turn from the characters that the bridge sends, with the characters per token of the last measured call. The estimate no longer counts Grok's thinking, which the bridge does not send. Each Cursor message keeps a `cursor_usage` diagnostic with the values.
- Keep the full output of a run instead of the output of one model call. Estimate the output of a turn that hands a tool call to pi from Cursor's streamed token counts, scaled by the ratio of reported to streamed output of the earlier runs, weighted by their streamed tokens. The old estimate left out Grok's reasoning, so tokens-per-second meters showed 2.6 to 5.6 for Grok tool calls.

## [0.2.3] - 2026-09-04

### Fixed

- Consume rejected asynchronous Cursor SDK cancellation promises so aborting a pi turn does not crash the process with an uncaught `AbortError`.

## [0.2.2] - 2026-09-04

### Fixed

- Bridge the Cursor streams into pi-ai's compatibility registry so Hermes Memory and other legacy `completeSimple()` callers can use Cursor for side-channel requests.
- Configure the Cursor SDK's bundled ripgrep binary when Pi's PATH does not expose it, avoiding repeated ignore-mapping errors.

## [0.2.0] - 2026-08-27

### Changed

- **Breaking:** Cursor is now a model inside **pi's harness**. Pi's system prompt, conversation, and tools are the request; Cursor is inference only. Pi executes tools (including extension tools such as pi-lens). Cursor's built-in file/shell tools stay disabled.
- Provider registration uses pi's `createProvider()` + `envApiKeyAuth` + `fetchModels` (native `/login` and catalog refresh).
- Each turn sends pi's full context (system prompt, conversation, and tool results) instead of only the last user message.
- Dropped per-session Cursor agent reuse. A fresh agent is created for every model round-trip.

### Added

- Cursor custom-tool and MCP calls are unwrapped and emitted as pi `toolCall` events so pi can run them and continue the loop.

## [0.1.2] - 2026-08-27

### Changed

- README rewritten as public install docs (npm/git install and uninstall, settings, `/login`)
- Changelog version links point at GitHub instead of mixed npm/GitHub URLs
- Link [`pi-cursor-sdk`](https://www.npmjs.com/package/pi-cursor-sdk) as the conflicting alternative
- [AGENTS.md](https://github.com/morizkay/pi-cursor-auth/blob/main/AGENTS.md) for contributors working in this repo

## [0.1.1] - 2026-08-27

### Added

- Changelog
- GitHub Release so the repo has a tagged version besides npm

## [0.1.0] - 2026-08-26

Initial public release. Minimal pi extension that uses a Cursor SDK API key as a model provider.

### Added

- `cursor` provider backed by `@cursor/sdk`, streaming thinking and text into pi
- API key resolution from `CURSOR_API_KEY`, pi `/login`, or `/cursor-auth`
- `/cursor-auth [key]` to store the key in `~/.pi/agent/auth.json`
- `/cursor-refresh-models` to reload the live Cursor model catalog
- Unknown model ids (including `auto-smart`) mapped to `cursor/default`
- Per-session Cursor agent reuse across follow-up turns
- Unit tests plus a live integration test against Cursor

### Fixed

- Streamed assistant text and thinking accumulated into a single pi block per turn (Cursor emits one word per chunk; without this, each word rendered on its own line)

[Unreleased]: https://github.com/morizkay/pi-cursor-auth/compare/v0.2.3...main
[0.2.3]: https://github.com/morizkay/pi-cursor-auth/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/morizkay/pi-cursor-auth/compare/v0.2.1...v0.2.2
[0.2.0]: https://github.com/morizkay/pi-cursor-auth/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/morizkay/pi-cursor-auth/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/morizkay/pi-cursor-auth/compare/579fc344fd29e85c1b2667c2d9a82f79dddbec87...v0.1.1
[0.1.0]: https://github.com/morizkay/pi-cursor-auth/tree/579fc344fd29e85c1b2667c2d9a82f79dddbec87
