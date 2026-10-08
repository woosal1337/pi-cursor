# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Declare `xhigh` and `max` in the `thinkingLevelMap` of each Cursor model when the live catalog offers them. Before this fix, pi hid both levels, and `cursor/grok-4.7` stopped at `high`.
- Read the system prompt and tools from pi's transcript system messages. Since pi 0.86, providers get a `TranscriptContext` without `context.systemPrompt` or `context.tools`, so Cursor ran with no pi tools and no system prompt.
- Estimate usage for a turn that hands a tool call to pi. Cursor reports usage only when a run ends, so these turns had zero usage, and context gauges such as `pi-minimal-footer` showed an empty context.
- Count Cursor's cached input tokens once. Cursor's `inputTokens` include `cacheReadTokens`, so pi showed too many tokens when Cursor used its cache.

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
