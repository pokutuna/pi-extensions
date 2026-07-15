# pi-extensions

Monorepo for pokutuna's [pi](https://pi.dev) extension packages.

See [docs/extensions.md](docs/extensions.md) for notes on how pi extensions work and how this repo is structured, and [docs/packages.md](docs/packages.md) for how packages are distributed, installed, and loaded.

## Packages

| Package                                                    | Description                       |
| ---------------------------------------------------------- | --------------------------------- |
| [`extensions/pi-hello`](extensions/pi-hello)               | Adds a `/hello` command           |
| [`extensions/pi-google-genai`](extensions/pi-google-genai) | Adds Google GenAI grounding tools |

## Development

```
npm install
npm run check   # lint + build + typecheck + test
```

Try an extension locally without installing it:

```
npm run build
pi -e ./extensions/pi-hello
```

## Tooling

- TypeScript
- [tsdown](https://tsdown.dev) for bundling (extensions ship built `dist/`, not `src/`)
- [oxlint](https://oxc.rs/docs/guide/usage/linter) for linting
- [oxfmt](https://oxc.rs/docs/guide/usage/formatter) for formatting
