# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

npm workspaces monorepo for [pi](https://pi.dev) (pi-coding-agent) extension packages, authored by pokutuna. Each `extensions/<name>/` directory is a self-contained npm package. `pi-google-genai` is published; `pi-hello` is `private: true` and exists as a local sample. Each extension has its own `DESIGN.md`/`README.md` — read those before working on a specific extension rather than expecting this file to cover per-extension details.

## Essential commands

- `npm run check` — lint + build + typecheck + test; run before considering work done
- `npm run build` — builds all workspaces; required before `pi -e ./extensions/<name>` (extensions ship built `dist/`, not `src/`)
- `npm run test -w extensions/pi-google-genai` — one workspace's tests. Only workspaces with a `test` script accept this; the root `npm run test` skips the others via `--if-present`.
- `cd extensions/pi-google-genai && node --test test/tools.test.ts` — a single test file

New extensions are created by copying an existing package under `extensions/`; there is no scaffold command.

## Running pi locally

`make pi ARGS="--no-session"` builds, loads `.env`, and starts `pi` with every `extensions/*` package enabled. Use it instead of calling `pi` directly: `pi` does not auto-load `.env`, and this repo pins a free OpenRouter model in `.pi-agent-dir/` (via `PI_CODING_AGENT_DIR`) so manual testing costs no tokens and leaves the global `~/.pi/agent/` config alone. `make env` regenerates `.env` from 1Password.

## Architecture

- **Package layout**: each `extensions/<name>/` has its own `package.json` and `tsconfig.json` (extends the root one). The root `package.json` (`package.json:7`) declares `workspaces: ["extensions/*"]` and fans commands out with `npm --workspaces run <cmd> --if-present`.
- **Build vs. no-build**: extensions are bundled with tsdown into `dist/`, and `package.json` `pi.extensions` points at the built file — unlike many community pi-extensions that ship raw `.ts`. See `extensions/pi-hello/src/hello.ts` for the minimal entry-point shape.
- **Extension API**: an extension's default export is `(pi: ExtensionAPI) => void`, registering commands/tools/hooks. The API surface (`pi.registerCommand`, `pi.on(event, handler)`, `ExtensionContext`, etc.) isn't guessable from this repo alone — read `docs/extensions.md` before writing or modifying extension code.

## Releasing

Tags are package-scoped: `<dir-name>-v<semver>` (e.g. `pi-google-genai-v0.1.0`). Pushing one publishes only that package, so untouched packages are never republished. `.github/workflows/publish.yml` refuses to run unless the tag version matches the package's `package.json`, the package is not `private`, and its `CHANGELOG.md` has an entry for that version. See the comment at the top of that file for the full release procedure.

A package's first publish must be done by hand (`npm publish -w <pkg> --access public`); npm Trusted Publishing (OIDC) is configured per-package on npmjs.com and cannot be set up before the package exists.

## Documentation

Read before starting related work:

- `docs/extensions.md` — the extension API reference (hooks, registration APIs, `ExtensionContext`)
- `docs/packages.md` — how packages are distributed/installed (npm/Git/local sources, the `pi` manifest, why Git sources can't target a monorepo subdirectory)
