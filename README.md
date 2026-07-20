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

```sh
npm install

# Read the token from a secret store — never inline it on the command line, which
# would write a live org write-token into your shell history.
export GITHUB_ORG=my-org
export GITHUB_TOKEN=$(op read op://vault/dotnet10-upgrader/token)

# Read-only dry run: print the upgrade queue and excluded repos.
npm run inventory

# Upgrade the first BATCH_SIZE queue repos sequentially and open PRs.
npm run run
```

Use the fine-grained PAT or GitHub App token from the prerequisites above — not
`gh auth token`, which hands over your personal token with every scope you hold
across every org you belong to. The upgrade loop runs the target repo's own build,
so the token it sits next to should reach nothing beyond the org being upgraded.
In CI, take `GITHUB_TOKEN` from the runner's secret store, or mint a short-lived
GitHub App installation token per run, rather than a long-lived PAT.

`.env` and `.env.*` are gitignored, but nothing in this project reads them — load
one yourself if you want it, e.g. `set -a; . ./.env; set +a` or a `.envrc`
containing `dotenv` for direnv.

`run` exits 0 only if every repo in the batch produced a PR. A repo whose loop does not conclusively succeed (no `UPGRADE_RESULT: SUCCESS` marker, timeout, non-zero exit, or no change outside build artifacts) produces no commit, branch, or PR — only `WORK_DIR/<repo>.claude.log` (failures before the loop runs, e.g. a failed clone, produce no log).

Self-checks: `npx tsx src/inventory.ts` (classifier) and `npx tsx src/upgrade.ts`
(success gate, token withholding, and PR-body quoting).
