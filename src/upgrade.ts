import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
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
const PR_PREAMBLE =
  "This pull request was produced by the automated dotnet10-upgrader loop (Claude Code `impl-loop`). " +
  "Verify that CI is green and review the diff before merging.";
// GitHub's PR body limit is 65536 characters; leave headroom for the preamble and markup.
const MAX_SUMMARY_CHARS = 60_000;

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
    const branch = `chore/dotnet10-upgrade-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`;
    git(["checkout", "-b", branch], repoDir, config.token);
    if (config.loopConfigDir) {
      fs.cpSync(config.loopConfigDir, path.join(repoDir, ".claude"), { recursive: true });
      // Local-only ignore: the agent sees .claude/, but git status and the commit never do.
      // ponytail: if the target repo tracks its own .claude/, cpSync overwrites tracked files and this won't hide that
      fs.appendFileSync(path.join(repoDir, ".git", "info", "exclude"), "/.claude/\n");
    }

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
      },
    );
    fs.writeFileSync(
      logFile,
      redact(`--- stdout ---\n${res.stdout ?? ""}\n--- stderr ---\n${res.stderr ?? ""}\n`, config.token),
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
    if (!/^UPGRADE_RESULT: SUCCESS\r?$/m.test(summary)) return fail("loop did not report UPGRADE_RESULT: SUCCESS");
    if (!git(["status", "--porcelain"], repoDir, config.token).trim()) {
      return fail("loop reported success but left no changes");
    }

    git(["add", "-A"], repoDir, config.token);
    git(["commit", "-m", COMMIT_MESSAGE], repoDir, config.token);
    git(["push", "origin", branch], repoDir, config.token);
    const { data: pr } = await octokit.pulls.create({
      owner: config.org,
      repo: report.name,
      title: COMMIT_MESSAGE,
      head: branch,
      base: report.defaultBranch,
      body: prBody(summary, config.token),
    });
    return { ok: true, prUrl: pr.html_url, logPath };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
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
  return text.replaceAll(token, "***");
}

function prBody(summary: string, token: string): string {
  const safe = redact(summary, token);
  const clipped = safe.length > MAX_SUMMARY_CHARS ? `${safe.slice(0, MAX_SUMMARY_CHARS)}\n…(truncated)` : safe;
  return `${PR_PREAMBLE}\n\n<details>\n<summary>Agent run summary</summary>\n\n${clipped}\n\n</details>`;
}
