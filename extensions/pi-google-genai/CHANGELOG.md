# Changelog

All notable changes to `@pokutuna/pi-google-genai` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-28

### Added

- `lookupPiConfig` option to reuse pi's own Google provider and credentials,
  including `GOOGLE_CLOUD_API_KEY` for Vertex AI. Defaults to `false`.
- `deep_research` answers now end with a `Sources:` list of every page cited,
  numbered with the agent's own `[cite: N]` numbers so a marker in the report
  points at its entry.

### Fixed

- `deep_research` dropped the opening of any report that embeds a chart. Such a
  report arrives split across steps (text, image, text) and only the last part
  was used; the report is now reassembled from all of them.
- Grounded tool timeouts reported a bare `HTTP 504 DEADLINE_EXCEEDED` instead of
  the timeout message, because the SDK's server-side deadline could fire just
  before the local one. The local timer now always wins.
- `deep_research` API failures are reported in the same
  `Google GenAI request failed (HTTP ...)` shape as the other tools.

## [0.1.0] - 2026-07-16

### Added

- Initial release: `google_search`, `google_maps`, `url_context`, and `deep_research`
  grounding tools backed by Google GenAI.
