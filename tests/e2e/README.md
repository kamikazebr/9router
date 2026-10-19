# Quota guard dashboard e2e (headless)

Playwright (own headless Chromium) against a throwaway 9router Docker container.
The script creates a temp data dir, boots the container once (migrations), stops it,
seeds 3 Claude connections (Owner A/B/C) into SQLite with `node:sqlite`, boots again,
runs the checks and always stops the container and removes the temp dir.

## Run

```sh
# from repo root: build the image
scripts/fork/build-image.sh   # builds 9router:<fork version of HEAD>, see FORK.md

cd tests/e2e
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts --no-audit --no-fund
node quota-guard.e2e.mjs        # Node >= 22.5 (node:sqlite)
```

Playwright 1.59.0 needs the cached browser revision chromium 1217
(`~/.cache/ms-playwright`); if missing: `npx playwright install chromium-headless-shell`.

Env: `IMAGE` (image tag), `E2E_PORT` (default 20197), `SHOTS_DIR` (screenshots,
default `../../../9router-patches/e2e-screenshots`), `E2E_TMPDIR`, `E2E_KEEP_DIR=1`.

Checks marked `knownBug` print XFAIL and do not fail the run; they flip to XPASS once fixed.
Exit code is 1 if any non-known check fails.
