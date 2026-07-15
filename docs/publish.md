# Publishing a package to npm

This document walks through releasing one `extensions/<name>/` package in
this repo. The authoritative trigger logic lives in
`.github/workflows/publish.yml`; read the comment at the top of that file
alongside this one.

Check which situation applies before starting:

- **Adding a brand-new package** (nothing under `extensions/<name>/` yet) →
  start at [Adding a new package](#adding-a-new-package).
- **That package has never been published to npm** (`npm view
  @pokutuna/<pkg> version` 404s) → [First release of a new package](#first-release-of-a-new-package).
- **Releasing a new version of a package that is already on npm** →
  [Every release](#every-release) is the whole procedure.

## Adding a new package

1. Copy an existing package under `extensions/` as a starting point (there is
   no scaffold command — see the root `CLAUDE.md`).
2. Set `package.json`: unique `name` (scoped `@pokutuna/pi-xxx`), `version`
   `"0.0.1"` or similar, `private: false` once you intend to publish it
   (`pi-hello` stays `private: true` on purpose as a local-only sample —
   `publish.yml` refuses to publish anything marked private).
3. Create `extensions/<pkg>/CHANGELOG.md` with an `[Unreleased]` section
   (see any existing package's CHANGELOG for the exact format the workflow's
   "Verify CHANGELOG contains release version" step expects: a `## [x.y.z]`
   heading matching the tag's version).
4. Once ready to ship the first version, move to **First release of a new
   package** below — do not tag yet.

## First release of a new package

The workflow cannot publish a package that has never been published, because
npm Trusted Publishing (OIDC) can only be configured for a package that
already exists on the registry (see the NOTE in `publish.yml`). This makes
the first release a different, manual sequence:

1. Do steps 1–3 from **Every release** below (version bump, CHANGELOG,
   commit) — but do **not** tag yet.
2. Publish by hand: `npm publish -w @pokutuna/<pkg> --access public`.
3. On <https://www.npmjs.com/package/@pokutuna/`<pkg>`/access>, add a Trusted
   Publisher: GitHub Actions, org `pokutuna`, repo `pi-extensions`, workflow
   filename `publish.yml`, no environment. Under "Allowed actions", `Allow npm
   publish` is enough — this workflow never uses staged publishing, so `Allow
   npm stage publish` is unnecessary.
4. Now tag and push per step 4 of **Every release**. CI will run, but its
   `npm publish` step fails on purpose — the version is already published
   manually — with `You cannot publish over the previously published
   versions`. That failure is expected and confirms the Trusted Publisher
   connection itself works (every step before it, including npm auth,
   succeeded); the subsequent `gh release create` step is skipped as a
   result.
5. Create the GitHub Release by hand once, since CI skipped it:
   ```bash
   gh release create "pi-google-genai-v0.1.0" \
     --title "@pokutuna/pi-google-genai v0.1.0" \
     --generate-notes
   ```
6. From the *next* version onward, **Every release** below is sufficient on
   its own — CI publishes and creates the Release without manual steps.

## Every release

1. Decide the new version (Semantic Versioning: MAJOR.MINOR.PATCH).
2. Update `extensions/<pkg>/CHANGELOG.md`: move items from `[Unreleased]` into
   a new `## [x.y.z] - YYYY-MM-DD` section.
3. Bump the version and commit, e.g. for `pi-google-genai`:
   ```bash
   npm version patch -w @pokutuna/pi-google-genai --no-git-tag-version
   git add extensions/pi-google-genai/package.json extensions/pi-google-genai/CHANGELOG.md package-lock.json
   git commit -m "release: pi-google-genai v0.1.0"
   ```
4. Create the tag and **push it on its own**, not bundled with a branch push:
   ```bash
   git tag pi-google-genai-v0.1.0
   git push origin pi-google-genai-v0.1.0
   ```
   Pushing the tag together with `main` (`git push origin main --tags`) was
   observed once to silently not trigger the `Publish Package` workflow at
   all — no run appears, no error, nothing. Re-pushing the same tag by itself
   (`git push origin :refs/tags/<tag>` then `git push origin refs/tags/<tag>`)
   reliably triggered it. Root cause unconfirmed; treat "push the tag alone"
   as the safe default rather than something to re-diagnose each time.
5. Watch the run: `gh run list --workflow=publish.yml --limit 3`. On a package
   that already has Trusted Publishing configured, this single push finishes
   the whole release — npm publish and GitHub Release both happen in CI.
