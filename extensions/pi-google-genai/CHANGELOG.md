# Changelog

All notable changes to `@pokutuna/pi-google-genai` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Moved `typebox` from `dependencies` to `peerDependencies` (`"*"`). It is bundled by
  the pi runtime and must not be installed separately by consumers.

## [0.0.1] - 2026-07-15

### Added

- Initial release: `google_search`, `google_maps`, `url_context`, and `deep_research`
  grounding tools backed by Google GenAI.
