# Loader regression tests

Run `npm test` with Node.js 22 or later. No npm dependencies are required.

These tests use Node's built-in test runner and mocked Electron interfaces.
All filesystem fixtures are created in a unique temporary directory. They do
not launch QQ, change registry values, install a loader, or read user profiles.

Coverage includes:
- resolved/rejected asynchronous IPC results and explicit sync/Promise errors;
- preserved API receiver and rejected malformed/prototype paths;
- idempotent IPC setup;
- native preload deduplication, failed-registration retry, legacy array isolation;
- the uncached Electron BrowserWindow fallback;
- protocol registration after app readiness and canonical filesystem boundaries;
- asynchronous preload dialog calls;
- native QQ handoff even if the loader bootstrap fails;
- explicit startup status rather than inferred require() success;
- atomic configuration replacement and old-file preservation on failure;
- retention of failed queued plugin deletions without removing plugin content.

The CI matrix covers Windows/Linux with Node.js 22/24. Mock tests do not prove
QQ integration or plugin compatibility. The repaired loader was separately
observed running on Windows QQ 9.9.37-54395, with loader startup status and
main/preload/renderer events. Private runtime logs and screenshots are not
included in this contribution.
