# Loader regression tests

Run `npm test` with Node.js 22 or later. No npm dependencies are required.
The 55 tests use Node's built-in runner, shared mocked Electron fixtures, and
unique temporary filesystem profiles. They do not launch QQ, modify registry
values, install a real loader, or inspect account/chat data.

## Startup and IPC
- resolved/rejected async IPC, explicit sync/Promise errors and correct receiver;
- malformed/prototype API path rejection and idempotent IPC setup;
- native preload deduplication, failed-registration retry and legacy array isolation;
- uncached Electron BrowserWindow fallback and canonical filesystem boundaries;
- deferred protocol setup, including partial-registration retries per scheme;
- every public dialog-install alias uses async invoke;
- native QQ handoff despite bootstrap failure and explicit startup status.

## Plugin lifecycle and data preservation
- activation failure restores the complete old plugin; failed rollback retains a
  recoverable old version and reports its path;
- post-activation cleanup failure cannot misreport a successful installation;
- replacement preserves plugin data and rejects missing/mismatched manifest slugs;
- invalid/reserved slugs, unknown modes and malformed deletion options are rejected;
- no-op deletion choices, including protected plugins, remove no files;
- data-only deletion and failed plugin removal preserve enable/disable state;
- all-mode removal leaves data untouched if the plugin directory cannot be moved;
- queued deletion retains failures, updates legacy disabled lists consistently,
  and preserves newly queued requests and unrelated settings;
- locked legacy config writes permit an idempotent retry;
- atomic configuration replacement preserves the old file on write failure.

## Shared configuration and asynchronous APIs
- shared preferences synchronize the legacy override without losing other keys;
- failed writes restore exact original bytes, including a UTF-8 BOM;
- blocked rollback retains and reports an original-file backup;
- later legacy edits are not overwritten by rollback;
- malformed shared types/JSON are rejected without overwriting old files;
- unrelated preferences leave the legacy file unchanged;
- config namespaces reject traversal/reserved names and junction/symlink escapes;
- public async preload methods use invoke, while private synchronous preload
  module-loading operations retain their existing synchronous transport;
- shell operations await completion and report failure rather than immediate true.

CI covers Windows/Linux with Node.js 22/24. Mock tests do not prove QQ integration
or compatibility with every plugin/version. The first repair commit was separately
observed running on Windows QQ 9.9.37-54395. The lifecycle follow-up has not been
installed into the live QQ client; private logs and screenshots are not published.
