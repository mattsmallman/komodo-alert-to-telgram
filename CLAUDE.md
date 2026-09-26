# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

A Cloudflare Worker that receives Komodo alerts from a Custom alerter and sends them to Telegram. User-facing setup is in [README.md](README.md).

- [app.js](app.js) holds all worker code: the HTTP entry point, the `AlertDebouncer` Durable Object, and message formatting.
- [test/debouncer.test.js](test/debouncer.test.js) tests the debouncer, formatting and entry point with stubbed storage and Telegram API.

## Commands

```bash
npm test          # run tests (node:test, no Cloudflare runtime needed)
npm run check     # wrangler dry-run build
npm run dev       # local worker, reads .dev.vars
```

Do not run `npm run deploy` unless asked. Releases deploy from GitHub when a `v*` tag is pushed (see [.github/workflows/deploy.yml](.github/workflows/deploy.yml)).

## Alert handling

Komodo sends three kinds of alert. See `LIFECYCLE_TYPES` and `STATE_CHANGE_TYPES` in [app.js](app.js).

1. **Lifecycle alerts** (`ServerCpu`, `ServerMem`, `ServerDisk`, `ServerUnreachable`, `ServerVersionMismatch`, `SwarmUnhealthy`, `ResourceSyncPendingUpdates`). Komodo sends `resolved: false` when they open or change level, then `resolved: true` with `level: OK` when they clear. The worker debounces the open alert. A resolution before sending cancels it. A resolution after sending sends a follow-up.
2. **State changes** (`StackStateChange`, `ContainerStateChange`). Komodo always sends these with `resolved: true` and `level: WARNING`. The worker debounces them against a baseline state. Returning to the baseline cancels the message. A move to `running` is only sent as a recovery after a problem was reported.
3. **Events** (everything else, for example `BuildFailed`, `StackImageUpdateAvailable`, `Test`, `Custom`). Also sent with `resolved: true`. The worker sends them immediately. A failed send is stored under a `retry:` key.

Debouncer entries are keyed by target, alert type and (for disks) mount path. They live in Durable Object storage and are sent by `alarm()`. After `MAX_SEND_ATTEMPTS` failures an entry is still marked as sent, so its recovery message goes out.

## Komodo alert format

The source of truth is `client/core/rs/src/entities/alert.rs` in moghtech/komodo. Komodo's own message wording is in `bin/core/src/alert/mod.rs` (`standard_alert_content`).

- `target.type` is capitalised (`Server`, `Stack`, `ResourceSync`). The worker lowercases it before looking up `TARGET_PATHS`.
- Levels are only `OK`, `WARNING` and `CRITICAL`.
- Stack and deployment states are snake_case (`running`, `not_deployed`).
- `err` on `ServerUnreachable` and `SwarmUnhealthy` is `{ error, trace }`.

When Komodo adds an alert type, add a case to `describe()` and a test. Unknown types fall back to a truncated JSON dump. When it adds a resource type, add it to `TARGET_PATHS`.

## Authentication

Komodo's Custom alerter only has a URL setting. The key arrives either as basic-auth credentials (reqwest moves URL userinfo into an `Authorization` header) or as `?api_key=`. Never log the request URL.

## Messages

Messages use Telegram `parse_mode: HTML`. Escape every value with `escapeHtml()`. Keep line values under `MAX_LINE_LENGTH` and bodies under `MAX_BODY_LENGTH` so messages stay within Telegram's 4096-character limit.
