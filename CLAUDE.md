# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

npm workspaces monorepo for [pi](https://pi.dev) (pi-coding-agent) extension packages, authored by pokutuna. Each extension lives under `extensions/<name>/` as an independent npm package (e.g. `pi-hello`, `pi-google-genai`). Each extension package has its own `DESIGN.md`/`README.md`; read those before working on a specific extension rather than expecting this file to cover per-extension details.

## Commands

```
npm install
npm run check     # lint + build + typecheck + test (run before considering work done)
npm run lint       # oxlint .
npm run build      # builds all workspaces (npm --workspaces run build --if-present)
npm run typecheck  # tsc --noEmit across all workspaces
npm run test       # runs each workspace's test script, if present
```

Try an extension locally without installing it (build first — extensions ship `dist/`, not `src/`):

```
npm run build
pi -e ./extensions/pi-hello
```

There is no per-extension "new extension" scaffold command; new extensions are created by copying an existing package under `extensions/`.

## Architecture

- **Package layout**: each `extensions/<name>/` is its own npm package with its own `package.json`, `tsconfig.json` (extends the root `tsconfig.json`), and `src/`. The root `package.json` declares `workspaces: ["extensions/*"]` and fans commands out with `npm --workspaces run <cmd> --if-present`.
- **Build vs. no-build**: this repo builds extensions with [tsdown](https://tsdown.dev) into `dist/` rather than shipping raw `src/*.ts` (unlike many community pi-extensions repos that publish `.ts` directly and rely on pi's jiti-based on-the-fly transpilation). Each package's `package.json` points `pi.extensions` at the built file (e.g. `./dist/hello.mjs`), and `prepublishOnly` runs the build automatically on `npm publish`.
- **Extension entry point**: an extension is a TypeScript module whose default export is `(pi: ExtensionAPI) => void` (or `async`), registering commands/tools/hooks. See `extensions/pi-hello/src/hello.ts` for the minimal shape, and `docs/extensions.md` for a full reference of the extension API (`pi.registerCommand`, `pi.registerTool`, `pi.on(event, handler)`, `ExtensionContext`, etc.) — read that doc before writing or modifying extension code, since the API surface isn't guessable from this repo alone.
- **Local dev model config**: this repo pins a free OpenRouter model for token-free manual testing, isolated from global `~/.pi/agent/` config. `pi` doesn't auto-load `.env`, so run it via `make pi ARGS="..."`. Setup and rationale: `docs/openrouter-free-model.md`.

## Tooling

- TypeScript, `strict: true`, `NodeNext` module resolution (see root `tsconfig.json`)
- [tsdown](https://tsdown.dev) for bundling
- [oxlint](https://oxc.rs/docs/guide/usage/linter) for linting (`.oxlintrc.json`)
- [oxfmt](https://oxc.rs/docs/guide/usage/formatter) for formatting
