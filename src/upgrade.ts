import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Octokit } from "@octokit/rest";
import type { RepoReport } from "./inventory";

export type UpgradeConfig = {
  org: string;
  token: string;
  workDir: string;
  timeoutMinutes: number;
  loopConfigDir?: string;
};

export type UpgradeOutcome = {
  ok: boolean;
  prUrl?: string;
  reason?: string;
  /** Absent when the run failed before the Claude log was written (e.g. clone failure). */
  logPath?: string;
};

const COMMIT_MESSAGE = "chore: upgrade to .NET 10 (LTS)";
const COMMIT_IDENTITY = { name: "dotnet10-upgrader", email: "dotnet10-upgrader@users.noreply.github.com" };
const PR_PREAMBLE =
  "This pull request was produced by the automated dotnet10-upgrader loop (Claude Code `impl-loop`). " +
  "Verify that CI is green and review the diff before merging.";
// GitHub's PR body limit is 65536 characters; leave headroom for the preamble and markup.
const MAX_SUMMARY_CHARS = 60_000;
// Build output the agent's `dotnet build`/`dotnet test` leaves behind. Excluded locally so
// `git add -A` can still pick up new source files without committing artifacts. One source of
// truth: the exclude patterns git consumes, and the matcher that re-checks the staged list
// (needed because exclude only suppresses UNTRACKED paths — see the gate in upgradeRepo).
const ARTIFACT_DIRS = ["bin", "obj", "TestResults"];
const ARTIFACT_EXCLUDES = [...ARTIFACT_DIRS.map((d) => `${d}/`), "*.binlog"];
const ARTIFACT_PATH = new RegExp(`(^|/)(${ARTIFACT_DIRS.join("|")})/|\\.binlog$`);

const PLAYBOOK = `Upgrade this repository to .NET 10 (LTS).
- Update global.json (if present) and every <TargetFramework>/<TargetFrameworks> value to net10.0, preserving OS-specific suffixes (e.g. net8.0-windows becomes net10.0-windows).
- Update NuGet package references to stable versions compatible with net10.0.
- Fix any resulting build or test breaks, including Dockerfile base images and SDK version pins.
- Both 'dotnet build' and 'dotnet test' must pass.
- Make no changes unrelated to the upgrade.
- End your final summary with exactly one line: UPGRADE_RESULT: SUCCESS if build and tests pass, or UPGRADE_RESULT: FAILED otherwise.`;

export async function upgradeRepo(
  octokit: Octokit,
  config: UpgradeConfig,
  report: RepoReport,
): Promise<UpgradeOutcome> {
  // Resolve once so every subsequent path and subprocess cwd is absolute, independent of process cwd.
  const workDir = path.resolve(config.workDir);
  const repoDir = path.join(workDir, report.name);
  const logFile = path.join(workDir, `${report.name}.claude.log`);
  let logPath: string | undefined; // set only once the log has actually been written
  // Redaction choke points: every string leaving this module passes through fail(), the log write, or prBody().
  const fail = (reason: string): UpgradeOutcome => ({
    ok: false,
    reason: redact(reason, config.token),
    logPath,
  });

  try {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
    const cloneUrl = `https://github.com/${config.org}/${report.name}.git`;
    git(["clone", "--depth", "1", cloneUrl, repoDir], workDir, config.token);
    // Minute precision, not just the date: a same-day re-run must not collide with the branch
    // the previous run already pushed (the push would be rejected non-fast-forward).
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13).replace("T", "-");
    const branch = `chore/dotnet10-upgrade-${stamp}`;
    git(["checkout", "-b", branch], repoDir, config.token);
    // Local-only ignores: the agent still sees these paths, git status and the commit never do.
    const excludes = [...ARTIFACT_EXCLUDES];
    if (config.loopConfigDir) {
      // exclude only suppresses untracked paths, so copying over a tracked .claude/ would publish
      // the operator's config in the PR. Bail instead.
      if (git(["ls-files", ".claude"], repoDir, config.token).trim()) {
        return fail("repo tracks its own .claude/; refusing to overwrite it with LOOP_CONFIG_DIR");
      }
      fs.cpSync(config.loopConfigDir, path.join(repoDir, ".claude"), { recursive: true });
      excludes.push("/.claude/");
    }
    // One append, and a leading newline so a template without a trailing one can't swallow the
    // first pattern by concatenating it onto its last line.
    const excludeFile = path.join(repoDir, ".git", "info", "exclude");
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    fs.appendFileSync(excludeFile, `\n${excludes.join("\n")}\n`);

    const res = spawnSync(
      "claude",
      [
        "-p",
        `/impl-loop ${PLAYBOOK}`,
        "--output-format",
        "json",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Read,Edit,Write,Glob,Grep,Bash(dotnet:*),Bash(git:*)",
      ],
      {
        cwd: repoDir,
        encoding: "utf8",
        timeout: config.timeoutMinutes * 60_000,
        maxBuffer: 64 * 1024 * 1024,
        env: childEnv(config.token),
      },
    );
    // 0600: the log is verbatim agent output from an untrusted repo and may echo that repo's own
    // secrets; only our token is redacted. Don't hand it to every user on a shared CI host.
    fs.writeFileSync(
      logFile,
      redact(`--- stdout ---\n${res.stdout ?? ""}\n--- stderr ---\n${res.stderr ?? ""}\n`, config.token),
      { mode: 0o600 },
    );
    logPath = logFile;

    if (res.error) return fail(`claude did not complete: ${res.error.message}`);
    if (res.status !== 0) return fail(`claude exited with status ${res.status ?? `signal ${res.signal}`}`);
    let summary: string;
    try {
      summary = String(JSON.parse(res.stdout).result ?? "");
    } catch {
      return fail("could not parse claude JSON output");
    }
    if (!succeeded(summary)) return fail("loop did not report UPGRADE_RESULT: SUCCESS");

    // Stage first, then judge. .git/info/exclude only suppresses UNTRACKED artifacts, so a repo
    // that commits its own obj/ would otherwise pass this gate on rebuilt output alone and open a
    // PR containing no actual upgrade. Re-filter the staged list to require one real change.
    git(["add", "-A"], repoDir, config.token);
    const staged = git(["diff", "--cached", "--name-only"], repoDir, config.token)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!staged.some((p) => !ARTIFACT_PATH.test(p))) {
      return fail("loop reported success but left no non-artifact changes");
    }
    git(["commit", "-m", COMMIT_MESSAGE], repoDir, config.token);
    git(["push", "origin", branch], repoDir, config.token);
    let pr: { html_url: string };
    try {
      ({ data: pr } = await octokit.pulls.create({
        owner: config.org,
        repo: report.name,
        title: COMMIT_MESSAGE,
        head: branch,
        base: report.defaultBranch,
        body: prBody(summary, config.token),
      }));
    } catch (e) {
      // The branch is already on the remote; drop it so a failed repo leaves nothing behind
      // (and so the next run can reuse the name). Except on 422, which usually means a PR for this
      // head already exists — deleting the branch would break that open PR instead of cleaning up.
      if ((e as { status?: number }).status !== 422) {
        try {
          git(["push", "origin", "--delete", branch], repoDir, config.token);
        } catch {
          // best effort: the PR failure is the one worth reporting
        }
      }
      throw e;
    }
    return { ok: true, prUrl: pr.html_url, logPath };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// The marker must be the LAST non-empty line, not merely present: an agent that narrates
// "I would print UPGRADE_RESULT: SUCCESS, but the tests fail" and then ends with FAILED
// must not be read as success.
function succeeded(summary: string): boolean {
  const lines = summary.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) === "UPGRADE_RESULT: SUCCESS";
}

// The agent executes untrusted repo content (`dotnet build` runs that repo's MSBuild targets),
// so the org-wide write token must not be ambient in its environment; git() injects credentials
// per invocation instead. Withheld by VALUE, not by name: operators who follow the `gh` route
// commonly also have GH_TOKEN holding the same secret, and dropping only GITHUB_TOKEN would
// hand it straight back. Node reuse is off so a timeout kill doesn't leave MSBuild workers
// writing into the clone we are about to delete.
function childEnv(token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Empty token would match every variable — never let it blank the whole environment.
    if (k === "GITHUB_TOKEN" || (token && v?.includes(token))) continue;
    env[k] = v;
  }
  return { ...env, MSBUILDDISABLENODEREUSE: "1", DOTNET_CLI_USE_MSBUILD_SERVER: "0" };
}

// Throws raw messages; upgradeRepo's catch routes them through fail(), which redacts.
// Auth rides the env per invocation (the actions/checkout mechanism), so the token never touches
// argv, .git/config, or disk. ponytail: clobbers any operator-set GIT_CONFIG_* env for git subprocesses.
function git(args: string[], cwd: string, token: string): string {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      // Explicit identity: a clean CI host has no ~/.gitconfig, and `git commit` would abort
      // with "Author identity unknown" after the whole upgrade run has already been paid for.
      GIT_AUTHOR_NAME: COMMIT_IDENTITY.name,
      GIT_AUTHOR_EMAIL: COMMIT_IDENTITY.email,
      GIT_COMMITTER_NAME: COMMIT_IDENTITY.name,
      GIT_COMMITTER_EMAIL: COMMIT_IDENTITY.email,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    },
  });
  if (res.error) throw new Error(`git ${args[0]}: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`git ${args[0]} failed: ${res.stderr}`);
  return res.stdout;
}

// Keep in sync with the inline redaction in main.ts (the export contract keeps this module-internal).
function redact(text: string, token: string): string {
  // replaceAll("") matches every zero-width position and would shred the text into "***a***b***".
  return token ? text.replaceAll(token, "***") : text;
}

function prBody(summary: string, token: string): string {
  const safe = redact(summary, token);
  const clipped = safe.length > MAX_SUMMARY_CHARS ? `${safe.slice(0, MAX_SUMMARY_CHARS)}\n…(truncated)` : safe;
  // The summary is agent prose derived from untrusted repo content, so it is quoted, not trusted:
  // raw it could close the <details> early, autolink "Fixes #1" into closing an unrelated issue on
  // merge, or @-mention half the org. The fence must outrun the longest backtick run inside it.
  const longest = Math.max(0, ...[...clipped.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${PR_PREAMBLE}\n\n<details>\n<summary>Agent run summary</summary>\n\n${fence}text\n${clipped}\n${fence}\n\n</details>`;
}

// Self-check for the success gate — the one piece of logic standing between a failed upgrade
// and an opened PR:  npx tsx src/upgrade.ts
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const cases: [string, boolean][] = [
    ["done\nUPGRADE_RESULT: SUCCESS", true],
    ["done\nUPGRADE_RESULT: SUCCESS\r\n", true],
    ["done\nUPGRADE_RESULT: SUCCESS\n\n", true],
    ["I would print\nUPGRADE_RESULT: SUCCESS\nbut tests fail.\nUPGRADE_RESULT: FAILED", false],
    ["UPGRADE_RESULT: FAILED", false],
    ["End with UPGRADE_RESULT: SUCCESS if build and tests pass", false],
    ["", false],
  ];
  for (const [summary, want] of cases) {
    assert.strictEqual(succeeded(summary), want, JSON.stringify(summary));
  }

  // Set the vars first: asserting on an env that never held the token passes without exercising
  // anything, so the old form stayed green even if childEnv stopped withholding entirely.
  const secret = "ghp_selfcheck_secret";
  process.env.GITHUB_TOKEN = secret;
  process.env.GH_TOKEN = secret;
  process.env.UNRELATED = "keep-me";
  const env = childEnv(secret);
  assert.ok(!("GITHUB_TOKEN" in env), "childEnv must withhold GITHUB_TOKEN");
  assert.ok(!("GH_TOKEN" in env), "childEnv must withhold aliases holding the same secret");
  assert.strictEqual(env.UNRELATED, "keep-me", "childEnv must not drop unrelated vars");
  assert.ok("UNRELATED" in childEnv(""), "an empty token must not blank the environment");

  // The PR body quotes untrusted agent text; it must not be able to escape the <details>.
  const hostile = "ok\n</details>\n\nFixes #1 cc @octocat";
  const body = prBody(hostile, secret);
  assert.strictEqual(body.match(/<\/details>/g)?.length, 2, "summary must not close <details> early");
  assert.ok(/```text\n/.test(body), "summary must be fenced");
  assert.ok(prBody("a ``` b", secret).includes("````text"), "fence must outrun backticks in the summary");
  assert.strictEqual(redact("abc", ""), "abc", "empty token must not shred the text");

  const checks = cases.length + 8;
  console.log(`upgrade self-check: ${checks}/${checks} cases pass`);
}
