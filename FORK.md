# 9router fork

A fork of [decolua/9router](https://github.com/decolua/9router) that carries a few
patches upstream has not merged. Upstream stopped merging external pull requests in
July 2026, so the fork is the only way to ship them.

## Versions

`<upstream version>-fork.<n>`, for example `0.5.104-fork.1`.

- **Upstream version:** the `version` in `package.json`. The fork never edits that
  field, so upstream releases merge without a conflict on it. The build stamps the
  fork version into the image instead (`APP_VERSION`), and the dashboard shows it.
- **n:** starts at 1 for each upstream base and goes up with each fork release on
  that base. It goes back to 1 when the base changes.
- **Git:** each released commit gets an annotated tag `v<version>`.
- **Image:** tagged `9router:<version>`, and `$IMAGE_REPO:<version>` when published.
  It also carries labels:
  - `org.opencontainers.image.version`: the fork version
  - `org.opencontainers.image.revision`: the fork commit
  - `io.9router.upstream.version`: the upstream version
  - `io.9router.upstream.commit`: the upstream commit

Check an image's origin:

```sh
docker image inspect 9router:<version> --format '{{json .Config.Labels}}'
```

`scripts/fork/version.sh` prints the version of `HEAD`.

## Branches and remotes

- **`main`:** upstream plus our patches. It is kept up to date with `git merge` and
  never rebased, so `git log upstream/master..main` always lists exactly what is ours.
- **`upstream`:** decolua/9router. Push is disabled on purpose.
- **`origin`:** the fork's own repository, once it exists.

## Current base

| | |
|---|---|
| Fork version | `0.5.104-fork.1` |
| Upstream base | `0.5.104` @ `87a74e1` (2026-10-15) |

## Patches carried

| Area | Commit(s) | Why |
|---|---|---|
| Per-account quota guard | `923a176a` (upstream PR #4945 by rareba) | Pause an account at a chosen remaining allowance and resume it after the reset. |
| Quota guard review fixes | `4cf12da9` `df5c0da8` `9a7f2721` `37dfe7fb` `5265f0ce` `7646a4a0` | See the list below. |
| Claude-to-Claude stream decloak | `e65e20ce` | See the explanation below. |
| Reproducible builds | `ffc2884c` `14ab7ec4` | Upstream has no lockfile. The fork pins one and installs with `npm ci --ignore-scripts`. Only `better-sqlite3` may build. |
| Fork versioning | this file, `scripts/fork/`, Dockerfile labels | Fork versions with provenance. |
| Headless e2e | `ece25205`, `tests/e2e/` | Dashboard checks for the quota guard. |

**Quota guard review fixes:**
- A failed Claude usage read froze the usage cache until the access token rotated. This bug was already in upstream.
- The monitor rotated OAuth tokens on its own.
- Per-model Claude weekly windows (Fable, Opus) were ignored.
- The toggles silently overrode the guard.
- A window Claude stops reporting kept the account paused forever.
- Bulk import could write guard state.
- The Quota Tracker showed no guard badges.

**Claude-to-Claude stream decloak:** when another 9router sits upstream (the Haven
instance), its stream carries tool names with an `_ide` suffix. Same-format streams
were passed through, so those names reached Claude Code. Upstream #4342 (v0.5.91)
fixed only non-streaming responses.

When a patch reaches upstream, the merge drops our copy of it. Remove its row here.

## Updating to a new upstream release

```sh
scripts/fork/update-upstream.sh v0.5.110         # or upstream/master
# conflicts? resolve them, keeping the patches above; then:
git add <files> && git commit --no-edit
scripts/fork/update-upstream.sh --finish
```

The script:
1. Refuses refs younger than 14 days. This is a supply-chain cooldown; `ALLOW_YOUNG=1` overrides it.
2. Merges the ref with `--no-ff`.
3. Regenerates `package-lock.json` with `--before=<date of the upstream ref>`.
4. Runs the fork's own unit tests.

Then:
1. **Full suite against the upstream baseline:** upstream has about 90 failing tests
   of its own. Run `cd tests && npx vitest run` here and in a worktree of the same
   upstream ref. Only failures that appear here and not upstream count.
2. **Build:** `scripts/fork/build-image.sh`.
3. **Browser tests:** run `tests/e2e`, following its README.
4. **Upstream security changes:** read the commits and the advisories:
   ```sh
   gh api repos/decolua/9router/security-advisories
   ```
5. **Release:** update "Current base" above, then tag with `git tag -a v<version>`.

## Deployment notes

- Set `STRICT_SSL=true`. Since 0.5.95, upstream retries a provider call **without TLS
  verification** after a certificate error unless this is set.
- Keep `REQUIRE_API_KEY=true` and dashboard login enabled. The Cloud Sync to
  9router.com can be cut with `CLOUD_URL=http://127.0.0.1:9` plus an `extra_hosts`
  entry that resolves `9router.com` to `127.0.0.1`.
- Back up `/app/data` before switching versions. Migrations run on boot.
