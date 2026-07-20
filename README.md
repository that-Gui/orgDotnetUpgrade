# dotnet10-upgrader

CLI that inventories an organization's GitHub repositories for projects targeting modern .NET below version 10, then runs the existing Claude Code `impl-loop` on a small batch to upgrade them to .NET 10 (LTS) and opens pull requests. Humans remain the merge gate.

## Operator prerequisites

- `git` on PATH.
- Claude Code installed and authenticated, with the `impl-loop` slash command (and its agents) available — either in your user-level config or via `LOOP_CONFIG_DIR`.
- .NET 10 SDK installed, plus any SDKs the target repos currently pin.
- A GitHub token (fine-grained PAT or GitHub App token) scoped to **contents: read/write** and **pull-requests: write** for the org.

## Configuration (environment variables)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GITHUB_ORG` | yes | — | Organization to scan |
| `GITHUB_TOKEN` | yes | — | Auth for API, clone, and push |
| `WORK_DIR` | no | `./work` | Clones and per-repo Claude logs |
| `BATCH_SIZE` | no | `3` | Repos upgraded per `run` |
| `ACTIVE_MONTHS` | no | `12` | Repos pushed within this window count as active |
| `CLAUDE_TIMEOUT_MINUTES` | no | `90` | Per-repo Claude timeout |
| `LOOP_CONFIG_DIR` | no | unset | Copied into each clone as `.claude/` |

## Usage

Both scripts load a gitignored `.env` from the repo root if one is present, so put
`GITHUB_ORG` and `GITHUB_TOKEN` there rather than re-exporting them each shell:

```sh
# .env — gitignored, never committed
GITHUB_ORG=my-org
GITHUB_TOKEN=github_pat_...
```

```sh
npm install

# Read-only dry run: print the upgrade queue and excluded repos.
npm run inventory

# Upgrade the first BATCH_SIZE queue repos sequentially and open PRs.
npm run run
```

A real environment variable always wins over the `.env` entry of the same name, so
CI secrets are never shadowed by a file left on the runner. If you prefer not to
keep the token on disk at all, export it instead — read it from a secret store
rather than inlining it, which would write a live org write-token into your shell
history:

```sh
export GITHUB_TOKEN=$(op read op://vault/dotnet10-upgrader/token)
```

Use the fine-grained PAT or GitHub App token from the prerequisites above — not
`gh auth token`, which hands over your personal token with every scope you hold
across every org you belong to. The upgrade loop runs the target repo's own build,
so the token it sits next to should reach nothing beyond the org being upgraded.
In CI, take `GITHUB_TOKEN` from the runner's secret store, or mint a short-lived
GitHub App installation token per run, rather than a long-lived PAT.

`run` exits 0 only if every repo in the batch produced a PR. A repo whose loop does not conclusively succeed (no `UPGRADE_RESULT: SUCCESS` marker, timeout, non-zero exit, or no change outside build artifacts) produces no commit, branch, or PR — only `WORK_DIR/<repo>.claude.log` (failures before the loop runs, e.g. a failed clone, produce no log).

Self-checks: `npx tsx src/inventory.ts` (classifier) and `npx tsx src/upgrade.ts`
(success gate, token withholding, and PR-body quoting).
