# Distributing, installing, and loading pi packages

This document explains how to distribute extensions, how users install them, and how `pi` discovers their resources. For extension implementation and APIs, see [extensions.md](extensions.md).

`pi` calls a bundle of extensions, skills, prompt templates, and themes a **pi package**. Each `extensions/<name>/` directory in this repository is one pi package.

References:

- Official documentation: <https://pi.dev/docs/latest/packages>
- Source documentation shipped with `pi`: `$(dirname $(readlink -f $(which pi)))/../docs/packages.md`
  - This is the most reliable primary source; compare it after upgrading `pi`.
- Implementation: `dist/core/package-manager.js` (`DefaultPackageManager`) and `dist/utils/git.js` (`parseGitUrl`)

## Installing packages

```bash
pi install npm:@pokutuna/pi-google-genai@0.0.1
pi install git:github.com/pokutuna/pi-extensions@v1  # Requires a root pi manifest
pi install https://github.com/pokutuna/pi-extensions # Requires a root pi manifest
pi install ./relative/path/to/package
pi install /absolute/path/to/package

pi remove npm:@pokutuna/pi-google-genai
pi list                    # List packages in settings
pi update --extensions     # Update packages and reconcile pinned Git refs
pi update --all            # Update pi, packages, and reconcile pinned Git refs
```

By default, packages are recorded in user settings (`~/.pi/agent/settings.json`). Add `-l` to use project settings (`.pi/settings.json`). Project settings can be committed and shared with a team; for trusted projects, missing packages are installed automatically at startup.

To try a package once without installing it, use `-e`/`--extension`. The package is unpacked into a temporary directory and is available only for that run:

```bash
pi -e npm:@pokutuna/pi-google-genai
pi -e git:github.com/pokutuna/pi-extensions  # Requires a root pi manifest
pi -e ./extensions/pi-hello        # Useful during local development
```

> **Security:** pi packages run with full system access. Extensions can execute arbitrary code, and skills can instruct the model to perform arbitrary operations. Read third-party source code before installing it.

## The three supported source types

`DefaultPackageManager.parseSource` accepts only npm, Git, and local paths.

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- A versioned package is **pinned** and is excluded from updates by `pi update --extensions` and `pi update --all`.
- Packages are installed under `~/.pi/agent/npm/` for user settings or `.pi/npm/` for project settings.
- `settings.json` can set `npmCommand` to wrap npm commands with tools such as `mise` or `asdf`.

### Git

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- Without the `git:` prefix, only protocol URLs are accepted: `https://`, `http://`, `ssh://`, or `git://`. A shorthand such as `github.com/user/repo` requires `git:`.
- With `git:`, both `github.com/user/repo` and `git@github.com:user/repo` shorthands are accepted.
- SSH URLs use the existing SSH configuration, including `~/.ssh/config`.
- Clones are stored under `~/.pi/agent/git/<host>/<path>` for user settings or `.pi/git/<host>/<path>` for project settings.
- If the clone contains a `package.json`, `npm install` runs automatically. By default this is a production install (`npm install --omit=dev`), so declare runtime dependencies in `dependencies`.
- A ref is treated as a pinned tag or commit. `pi update` does not move it to a newer ref; it only reconciles the existing clone with the configured ref. To change the ref, run `pi install git:host/user/repo@new-ref` again.

Examples of URL parsing:

| Input | Result |
| --- | --- |
| `git:github.com/user/repo` | Accepted; repository is `https://github.com/user/repo` |
| `git:github.com/user/repo@v1.0.0` | Accepted and pinned |
| `https://github.com/user/repo` | Accepted |
| `git:git@github.com:user/repo` | Accepted |
| `github.com/user/repo` | Rejected; a protocol or `git:` prefix is required |
| `git:github.com/user/repo/extensions/pi-hello` | Parses, but cloning fails because it is treated as a repository URL |

### Local paths

```
/absolute/path/to/package
./relative/path/to/package
```

Local packages are not copied; only their paths are recorded in settings. Relative paths are resolved relative to the settings file. A file is loaded as a single extension, while a directory is loaded according to the package rules.

## Git packages cannot target a subdirectory

`parseGitUrl` always constructs the repository path as `info.user/info.project`, so there is no syntax for selecting one package inside a monorepo. A Git source always clones the entire repository.

For example, `git:github.com/user/repo/extensions/pi-hello` may parse successfully but is eventually cloned from the nonexistent URL `https://github.com/user/repo/extensions/pi-hello`, so it fails only during cloning.

For a monorepo such as this one, the practical options are:

- Publish each package to the npm registry and install it as `npm:@pokutuna/pi-xxx`. The monorepo can remain intact.
- Make the whole repository a Git-installable package. Add a root `package.json` with a `pi` manifest listing all extensions, then install `git:github.com/pokutuna/pi-extensions`. Users can select which resources to enable through settings filters or `pi config`.
  - This repository currently has no root `pi` manifest. It publishes built `dist/` files, so `dist/` must also be committed for Git installation to work. `prepublishOnly` runs for `npm publish`, not for a Git clone.
- Move each extension into its own repository.

## How `pi` loads package resources

`collectPackageResources` applies these rules in order:

1. Apply a filter from settings, if one exists.
2. Otherwise, read the `pi` manifest in `package.json`. If present, it is authoritative; convention directories are not scanned.
3. If there is no manifest, scan the convention directories.

### The `pi` manifest

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./dist/index.mjs"]
  }
}
```

Paths are relative to the package root. Arrays support globs and `!exclusions`. Add `pi-package` to `keywords` to list the package in the [package gallery](https://pi.dev/packages). Add `video` or `image` under `pi` to provide a preview.

### Convention directories

These directories are scanned only when no `pi` manifest exists:

- `extensions/` — `.ts` and `.js` files
- `skills/` — recursively discovered directories containing `SKILL.md`, plus top-level `.md` files
- `prompts/` — `.md` files
- `themes/` — `.json` files

## Dependencies

- Put third-party runtime dependencies in `dependencies`; npm and Git installation automatically run `npm install`.
- Do not bundle core packages shipped with `pi`. Declare them in `peerDependencies` with version `"*"`: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`.
- To include another pi package, add it to both `dependencies` and `bundledDependencies`, then reference it through `node_modules/`. Each package is loaded from an independent module root, so separate installations do not collide or share dependencies.

## Filtering resources in settings

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"]
    }
  ]
}
```

- Omit a key to load all resources of that type.
- Use `[]` to load none of that type.
- Use `!pattern` to exclude resources, and `+path` or `-path` to force-include or force-exclude an exact path.
- Filters are applied on top of the manifest and can only narrow the set of allowed resources.

`pi config` can enable or disable individual extensions, skills, prompts, and themes in installed packages. Press Tab to switch between global and project settings.

## Scope and duplicate resolution

When the same package exists globally and in a project, the project entry wins. If the project entry has `autoload: false`, it is applied as a set of differences to the global entry.

Package identity is determined by:

- npm: package name
- Git: repository URL without the ref
- local: resolved absolute path
