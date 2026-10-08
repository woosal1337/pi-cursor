# AGENTS.md

This is a [pi](https://pi.dev) extension. It registers a `cursor` provider with pi's `createProvider()` API. Cursor is used as a **model** inside pi's harness: pi owns tools, extensions, and the agent loop.

Do not re-enable Cursor's built-in file/shell tools. Surface model tool calls as pi `toolCall` events so pi-lens, ponytail, and other extensions stay in the loop. Do not depend on other Cursor provider packages.

## Layout

- `src/index.ts` — pi extension: `createProvider`, `/login` via `envApiKeyAuth`, `/cursor-auth`, `/cursor-refresh-models`
- `src/cursor-core.ts` — key resolution, harness prompt, model discovery, `runCursorTurn` (inject `createStream` / `createAgent` for tests)
- `test/cursor.test.ts` — unit tests plus a live Cursor integration test (skipped unless `CURSOR_API_KEY` is set)

## Commands

```bash
npm install
npm run check            # tsc --noEmit
npm test                 # unit tests; live test needs CURSOR_API_KEY
pi install ./            # load this checkout as a local pi package
```

Live test:

```bash
export CURSOR_API_KEY="crsr_..."
npm test
```

## Release procedure

npm is the canonical distribution channel. Public install instructions must use `pi install npm:pi-cursor-auth`; GitHub is only the source repository and release page.

1. Confirm the next version from `npm view pi-cursor-auth version` and the existing `v*` tags. Do not reuse a published npm version.
2. Update `package.json` and the root entry in `package-lock.json` to the same version.
3. Move `[Unreleased]` notes into `## [X.Y.Z] - YYYY-MM-DD`, leave `[Unreleased]` empty, and update the comparison links.
4. Update npm version pins in `README.md`; do not replace them with GitHub install commands.
5. Run `npm test`, `npm run check`, `npm pack --dry-run`, and `git diff --check`.
6. Commit the complete release. Verify the commit contains the released version and a clean working tree.
7. Publish from that commit with `npm publish --access public`; complete npm 2FA when prompted, then verify with `npm view pi-cursor-auth version`.
8. Create the matching annotated tag (`git tag -a vX.Y.Z -m "Release vX.Y.Z"`) on the release commit, push `main` and the tag to `origin`, and create the GitHub release from that exact tag.
9. Verify the GitHub tag, release, npm version, and repository `HEAD` all refer to the intended release.

A GitHub push and an npm publish are separate operations. Never claim the package is released until `npm view` confirms it.

## Rules

- Keep the provider small. New behavior belongs in `cursor-core.ts` if it is testable without pi.
- Register a complete pi-ai `Provider` (`createProvider` + `envApiKeyAuth` + `fetchModels`). Do not use the legacy `{ api, streamSimple, models }` config form.
- Each `streamSimple` call is one model round-trip, not a Cursor agent loop. Pass pi's system prompt, messages, and tools. Intercept Cursor custom-tool/MCP calls and emit pi `toolCall` events. Drop Cursor host tools (`shell`, `read`, …) that are not in `context.tools`.
- Stream Cursor chunks into **one** pi text block per turn (words must be joined with spaces).
- `auto` and `auto-smart` map to `cursor/default`. After the live catalog loads, other unknown model ids also map to `cursor/default`. Before it loads, keep the requested id, because pi's cached catalog came from Cursor.
- Send `fast` and `context` on every request. The base model sends `fast=false`, and its `-fast` copy sends `fast=true`. Use the smallest context option, and set `contextWindow` to match it.
- API key order: `options.apiKey` from pi auth, then `CURSOR_API_KEY`.
- Do not commit secrets (`.env`, `.cursor-key`, keys in `auth.json`).
- Public docs live in `README.md`. Follow pi's real CLI (`pi install npm:…`, `pi uninstall`, `/login`, `/model` + Ctrl+S).
