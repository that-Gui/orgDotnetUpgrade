import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
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
// "Verify that CI is green" was true when a green suite was the bar. It no longer is: a PR may
// carry failures that pre-date the upgrade, and telling the operator to expect green would read as
// the loop having lied. Check CI against what the body claims instead.
const PR_PREAMBLE =
  "This pull request was produced by the automated dotnet10-upgrader loop (Claude Code `impl-loop`). " +
  "Review the diff and check CI against the test status stated below before merging.";
// GitHub's PR body limit is 65536 characters; leave headroom for the preamble and markup.
const MAX_SUMMARY_CHARS = 60_000;
// A clone or push against a wedged remote otherwise blocks the whole run forever.
const GIT_TIMEOUT_MS = 10 * 60_000;
// GitHub's own repo-name charset. report.name is attacker-chosen (anyone who can create a repo in
// the org) and gets joined into a path we later rm -rf, so anything outside this set is a bug or an
// attack, never a repo we should touch.
const REPO_NAME = /^[A-Za-z0-9._-]+$/;
// Build output the agent's `dotnet build`/`dotnet test` leaves behind. Excluded locally so
// `git add -A` can still pick up new source files without committing artifacts. One source of
// truth: the exclude patterns git consumes, and the matcher that re-checks the staged list
// (needed because exclude only suppresses UNTRACKED paths — see the gate in upgradeRepo).
const ARTIFACT_DIRS = ["bin", "obj", "TestResults"];
const ARTIFACT_EXCLUDES = [...ARTIFACT_DIRS.map((d) => `${d}/`), "*.binlog"];
const ARTIFACT_PATH = new RegExp(`(^|/)(${ARTIFACT_DIRS.join("|")})/|\\.binlog$`);
// Paths a .NET upgrade never needs to touch, and that are dangerous in a PR: .github/ executes on
// the target repo's runners with that repo's secrets as soon as a maintainer opens the PR;
// .gitattributes and .claude/ are code-execution vectors for whoever reviews or re-runs; .env is
// how a build leaks credentials it happened to write. An injected agent wants all four.
const FORBIDDEN_PATH = /(^|\/)(\.github|\.claude)\/|(^|\/)(\.gitattributes|\.gitmodules)$|(^|\/)\.env(\.|$)/;

const PLAYBOOK = `Upgrade this repository to .NET 10 (LTS).
- FIRST, before you edit anything: run 'dotnet build', then 'dotnet test', on the repository exactly as you found it, and record the fully-qualified name of every failing test. That is the BASELINE. Capture it before your first edit — do not reconstruct it afterwards by stashing your changes.
- Update global.json (if present) and every <TargetFramework>/<TargetFrameworks> value to net10.0, preserving OS-specific suffixes (e.g. net8.0-windows becomes net10.0-windows).
- Update NuGet package references to stable versions compatible with net10.0.
- Fix any resulting build or test breaks, including Dockerfile base images and SDK version pins.
- 'dotnet build' must pass. Then re-run 'dotnet test': every test still failing must already be in the baseline. A test that passed in the baseline and fails now is a regression — fix it. Tests that were already failing may stay failing.
- If the baseline build did not succeed there is no usable baseline, and the strict bar applies instead: both 'dotnet build' and 'dotnet test' must pass outright.
- Make no changes unrelated to the upgrade.
- In your summary, name every baseline failure you are carrying forward and why it fails, so a human can check the claim against the base branch.
- End your final summary with exactly these three lines, in this order, with nothing after them:
BASELINE_FAILURES: <how many baseline failures are still failing; 0 if none>
REVIEWERS: PASS (only if both reviewers returned PASS with zero Criticals) or REVIEWERS: FAIL otherwise
UPGRADE_RESULT: SUCCESS (only if the build passes and no test regressed against the baseline) or UPGRADE_RESULT: FAILED otherwise`;

export async function upgradeRepo(
  octokit: Octokit,
  config: UpgradeConfig,
  report: RepoReport,
): Promise<UpgradeOutcome> {
  // Redaction choke points: every string leaving this module passes through fail(), the log write, or prBody().
  let logPath: string | undefined; // set only once the log has actually been written
  const fail = (reason: string): UpgradeOutcome => ({
    ok: false,
    reason: redact(reason, config.token),
    logPath,
  });

  if (!REPO_NAME.test(report.name) || report.name === "." || report.name === "..") {
    return fail(`refusing repo with unexpected name: ${JSON.stringify(report.name)}`);
  }
  // Resolve once so every subsequent path and subprocess cwd is absolute, independent of process cwd.
  const workDir = path.resolve(config.workDir);
  // rmSync(repoDir, {recursive, force}) below is only as safe as workDir. WORK_DIR="" or "." both
  // resolve to the process cwd, and an org repo named "src" or "node_modules" would then delete this
  // tool's own files. Refuse the three roots that make that possible.
  if (workDir === path.parse(workDir).root || workDir === process.cwd() || workDir === os.homedir()) {
    return fail(`refusing ${workDir} as WORK_DIR: pick a directory of its own`);
  }
  const repoDir = path.join(workDir, "repos", report.name);
  // Logs live in their own directory: sharing one with the clones lets a repo named
  // "foo.claude.log" collide with repo "foo"'s log file.
  const logFile = path.join(workDir, "logs", `${report.name}.log`);

  try {
    // maxRetries: orphaned build daemons from a timed-out previous run may still be writing here,
    // and a bare rmSync races them into ENOTEMPTY.
    fs.rmSync(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    // 0700: these directories hold clones of private repos, the copied LOOP_CONFIG_DIR, and the logs.
    // Don't hand them to every local user on a shared CI host.
    fs.mkdirSync(path.dirname(repoDir), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    const cloneUrl = `https://github.com/${config.org}/${report.name}.git`;
    git(["clone", "--depth", "1", cloneUrl, repoDir], workDir, config.token, true);
    // Minute precision, not just the date: a same-day re-run must not collide with the branch
    // the previous run already pushed (the push would be rejected non-fast-forward).
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13).replace("T", "-");
    const branch = `chore/dotnet10-upgrade-${stamp}`;
    git(["checkout", "-b", branch], repoDir, config.token);
    if (config.loopConfigDir) {
      // exclude only suppresses untracked paths, so copying over a tracked .claude/ would publish
      // the operator's config in the PR. Bail instead.
      if (git(["ls-files", ".claude"], repoDir, config.token).trim()) {
        return fail("repo tracks its own .claude/; refusing to overwrite it with LOOP_CONFIG_DIR");
      }
      fs.cpSync(config.loopConfigDir, path.join(repoDir, ".claude"), { recursive: true });
    }
    // Snapshot the config we cloned with, before the agent can touch it — see the restore below.
    const gitConfigFile = path.join(repoDir, ".git", "config");
    const pristineConfig = fs.readFileSync(gitConfigFile);

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
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024 * 1024,
        env: childEnv(config.token),
      },
    );
    // The agent ran with Write and Bash(git:*) inside this clone, so .git/config, .git/hooks and
    // .gitattributes are all attacker-writable by now — and every git call below would execute them:
    // filter.*.clean on `add`, pre-commit on `commit`, pre-push plus url.*.insteadOf/http.*.proxy on
    // `push` (the last two able to redirect the push, credential and all, to a host of their choice).
    // Restoring the config we cloned with and dropping the hooks directory closes the whole class at
    // once, which beats enumerating it. Do this before ANY further git call.
    fs.writeFileSync(gitConfigFile, pristineConfig);
    fs.rmSync(path.join(repoDir, ".git", "hooks"), { recursive: true, force: true });

    // Written after the agent, so a tampered exclude file can't smuggle artifacts past the gate below.
    // Local-only ignores: the agent still saw these paths, git status and the commit never do.
    const excludes = [...ARTIFACT_EXCLUDES, ...(config.loopConfigDir ? ["/.claude/"] : [])];
    const excludeFile = path.join(repoDir, ".git", "info", "exclude");
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    // One append, and a leading newline so a template without a trailing one can't swallow the
    // first pattern by concatenating it onto its last line.
    fs.appendFileSync(excludeFile, `\n${excludes.join("\n")}\n`);

    // 0600: the log is verbatim agent output from an untrusted repo and may echo that repo's own
    // secrets; only our token is redacted. Don't hand it to every user on a shared CI host.
    // rm + "wx" rather than a plain write: writeFileSync honours `mode` only when it creates the
    // file, so a second run would silently reuse a 0644 file — or follow a symlink planted there.
    fs.rmSync(logFile, { force: true });
    fs.writeFileSync(
      logFile,
      redact(`--- stdout ---\n${res.stdout ?? ""}\n--- stderr ---\n${res.stderr ?? ""}\n`, config.token),
      { mode: 0o600, flag: "wx" },
    );
    logPath = logFile;

    // ENOBUFS is maxBuffer overflow, not a spawn failure; say so rather than blaming `claude`.
    if (res.error) {
      const detail = (res.error as NodeJS.ErrnoException).code === "ENOBUFS" ? " (output exceeded 64 MiB)" : "";
      return fail(`claude did not complete: ${res.error.message}${detail}`);
    }
    if (res.status !== 0) return fail(`claude exited with status ${res.status ?? `signal ${res.signal}`}`);
    let summary: string;
    try {
      summary = String(JSON.parse(res.stdout).result ?? "");
    } catch {
      return fail("could not parse claude JSON output");
    }
    const loop = verdict(summary);
    if (!loop.ok) return fail(loop.reason);

    // The agent could have checked out something else; committing then would land on that branch
    // while we push an empty `branch`, leaving an orphan on the remote and a PR that 422s.
    const head = git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir, config.token).trim();
    if (head !== branch) return fail(`expected HEAD on ${branch} after the loop, found ${head}`);

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
    const forbidden = staged.filter((p) => FORBIDDEN_PATH.test(p));
    if (forbidden.length) {
      return fail(`refusing to open a PR touching protected paths: ${forbidden.slice(0, 5).join(", ")}`);
    }
    git(["commit", "--no-verify", "-m", COMMIT_MESSAGE], repoDir, config.token);
    // Push to the URL we cloned from, not to `origin`: the agent can rewrite a remote, and `origin`
    // would carry both the org's code and our Authorization header wherever it now points.
    git(["push", "--no-verify", cloneUrl, `${branch}:${branch}`], repoDir, config.token, true);
    let pr: { html_url: string };
    try {
      ({ data: pr } = await octokit.pulls.create({
        owner: config.org,
        repo: report.name,
        title: COMMIT_MESSAGE,
        head: branch,
        base: report.defaultBranch,
        body: prBody(summary, config.token, loop.baselineFailures),
      }));
    } catch (e) {
      // 422 here usually means a PR for this head already exists — most often because the retry
      // plugin re-sent a create that had actually succeeded behind a 5xx. Adopt that PR rather than
      // reporting a failure the operator would "fix" by re-running into a duplicate. Any other
      // failure: drop the branch so a failed repo leaves nothing behind and the name stays reusable.
      if ((e as { status?: number }).status === 422) {
        const { data: open } = await octokit.pulls.list({
          owner: config.org,
          repo: report.name,
          head: `${config.org}:${branch}`,
          state: "open",
        });
        if (open[0]) return { ok: true, prUrl: open[0].html_url, logPath };
      } else {
        try {
          git(["push", cloneUrl, "--delete", branch], repoDir, config.token, true);
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

type Verdict = { ok: true; baselineFailures: number } | { ok: false; reason: string };

// The markers must be the LAST three non-empty lines, not merely present: an agent that narrates
// "I would print UPGRADE_RESULT: SUCCESS, but the tests fail" and then ends with FAILED
// must not be read as success.
//
// REVIEWERS is a gate in its own right, not decoration. UPGRADE_RESULT reports only build and
// tests, so without it a loop that burns impl-loop's 4-round cap with unresolved Critical findings
// still opens a PR on a green build.
//
// BASELINE_FAILURES is not a gate — the agent already refuses SUCCESS on a regression. It is what
// prBody needs to stop claiming the suite is green on the one kind of PR where it isn't.
function verdict(summary: string): Verdict {
  const lines = summary.split("\n").map((l) => l.trim()).filter(Boolean);
  // A summary shorter than three lines leaves these undefined, which fails every check below.
  const [baseline, reviewers, result] = lines.slice(-3);
  if (result !== "UPGRADE_RESULT: SUCCESS") return { ok: false, reason: "loop did not report UPGRADE_RESULT: SUCCESS" };
  if (reviewers !== "REVIEWERS: PASS") {
    return { ok: false, reason: `loop did not report REVIEWERS: PASS (found ${JSON.stringify(reviewers ?? "")})` };
  }
  const count = /^BASELINE_FAILURES: (\d+)$/.exec(baseline ?? "");
  if (!count) {
    return { ok: false, reason: `loop did not report BASELINE_FAILURES (found ${JSON.stringify(baseline ?? "")})` };
  }
  return { ok: true, baselineFailures: Number(count[1]) };
}

// The agent executes untrusted repo content (`dotnet build` runs that repo's MSBuild targets),
// so the org-wide write token must not be ambient in its environment. Withheld by VALUE, not by
// name: operators who follow the `gh` route commonly also have GH_TOKEN holding the same secret,
// and dropping only GITHUB_TOKEN would hand it straight back. Node reuse is off so a timeout kill
// doesn't leave MSBuild workers writing into the clone we are about to delete.
// same-uid process introspection (/proc/<ppid>/environ) and on-disk credentials
// (~/.git-credentials, a .env above WORK_DIR) still reach the token — closing those needs a
// container or a separate uid, which is the real boundary. See README.
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
//
// `authenticate` is opt-in and true for exactly the two calls that talk to the remote. Every other
// call runs credential-free, so anything this repo still manages to execute has nothing to steal.
// Auth rides the env (the actions/checkout mechanism), so the token never touches argv or disk.
// GIT_CONFIG_NOSYSTEM/GLOBAL: the operator's own gitconfig must not reach these calls either — a
// `url."ssh://git@github.com/".insteadOf https://github.com/` rule (common on dev machines) would
// silently reroute the clone to SSH, and a credential.helper would persist secrets to disk.
// hooksPath=/dev/null: belt-and-braces over the hooks directory upgradeRepo already removed.
function git(args: string[], cwd: string, token: string, authenticate = false): string {
  const config: [string, string][] = [["core.hooksPath", "/dev/null"]];
  if (authenticate) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    config.push(["http.https://github.com/.extraheader", `AUTHORIZATION: basic ${basic}`]);
  }
  const env: NodeJS.ProcessEnv = {
    ...childEnv(token),
    GIT_TERMINAL_PROMPT: "0",
    // GIT_TERMINAL_PROMPT alone does not stop git from shelling out to an askpass helper; VS Code's
    // integrated terminal exports GIT_ASKPASS by default, and a stale token then hangs the run.
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    // Explicit identity: a clean CI host has no ~/.gitconfig, and `git commit` would abort
    // with "Author identity unknown" after the whole upgrade run has already been paid for.
    GIT_AUTHOR_NAME: COMMIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: COMMIT_IDENTITY.email,
    GIT_COMMITTER_NAME: COMMIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: COMMIT_IDENTITY.email,
    GIT_CONFIG_COUNT: String(config.length),
  };
  for (const [i, [key, value]] of config.entries()) {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  }
  const res = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, env });
  if (res.error) throw new Error(`git ${args[0]}: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`git ${args[0]} failed: ${res.stderr}`);
  return res.stdout;
}

/** Sole redaction helper; main.ts imports this rather than keeping a second copy in sync. */
export function redact(text: string, token: string): string {
  // Control characters travel with untrusted agent and git output: a CR or an ANSI sequence lets it
  // forge or erase operator-facing log lines. Keep \t and \n, drop the rest of C0/C1.
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
  // replaceAll("") matches every zero-width position and would shred the text into "***a***b***".
  if (!token) return clean;
  // Redact the credential as transmitted, not just as configured: what git echoes back on a failed
  // fetch is base64("x-access-token:<token>"), which decodes straight back to the token.
  const secrets = [
    token,
    Buffer.from(`x-access-token:${token}`).toString("base64"),
    Buffer.from(token).toString("base64"),
  ];
  return secrets.reduce((s, secret) => s.replaceAll(secret, "***"), clean);
}

function prBody(summary: string, token: string, baselineFailures: number): string {
  const safe = redact(summary, token);
  const clipped = safe.length > MAX_SUMMARY_CHARS ? `${safe.slice(0, MAX_SUMMARY_CHARS)}\n…(truncated)` : safe;
  // The summary is agent prose derived from untrusted repo content, so it is quoted, not trusted:
  // raw it could close the <details> early, autolink "Fixes #1" into closing an unrelated issue on
  // merge, or @-mention half the org. The fence must outrun the longest backtick run inside it.
  const longest = Math.max(0, ...[...clipped.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  const details = `<details>\n<summary>Agent run summary</summary>\n\n${fence}text\n${clipped}\n${fence}\n\n</details>`;
  // The loop no longer requires a green suite, only that it got no worse — so the body must not
  // claim one. A reviewer has to learn the suite is red from the PR itself, not by expanding
  // <details>, and gets a checklist item to confirm the count against the base branch.
  const tests =
    baselineFailures === 0
      ? "`dotnet build` and `dotnet test` both pass — the loop opens no PR otherwise."
      : `\`dotnet build\` passes. ${baselineFailures} test(s) were already failing on the base branch before this change and still fail, unchanged; no test that was passing now fails — the loop opens no PR otherwise.`;
  const checklist = ["- [ ] Code pipeline builds correctly"];
  if (baselineFailures > 0) {
    checklist.push(`- [ ] The ${baselineFailures} pre-existing test failure(s) are confirmed on the base branch`);
  }
  // The operator's PR template. Every line below is a constant we control, except `baselineFailures`
  // — a Number() of a \d+ capture, so it carries no markup. The only untrusted value is `clipped`,
  // sealed inside the fenced <details> above. Nothing agent-derived reaches a header, a checklist
  // item, or any unfenced position where it could inject markup, autolink, or mention.
  return [
    "## [Dotnet upgrade agent workflow.]()",
    "",
    PR_PREAMBLE,
    "",
    "### `    Describe this PR    `",
    "",
    "Automated upgrade of this repository to .NET 10 (LTS), opened by the dotnet10-upgrader loop.",
    "",
    "### `    What is the problem we're trying to solve?    `",
    "",
    "This repository targeted a .NET release older than .NET 10 (LTS); this PR moves it onto the current LTS so it stays in support.",
    "",
    "### `    What changes have we introduced?    `",
    "",
    `Target frameworks (and \`global.json\`, if present) moved to \`net10.0\`, NuGet references updated to net10.0-compatible stable versions, and the resulting build/test breaks fixed. ${tests} The agent's full run summary (untrusted repo output, quoted verbatim):`,
    "",
    details,
    "",
    "#### `    Checklist    `",
    "",
    ...checklist,
    "",
    "### `    Follow up actions after merging PR    `",
    "",
    "None.",
  ].join("\n");
}

// Self-check for the gates standing between a failed or hostile upgrade and an opened PR:
//   npx tsx src/upgrade.ts
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const green = "BASELINE_FAILURES: 0\nREVIEWERS: PASS\nUPGRADE_RESULT: SUCCESS";
  const carried = "BASELINE_FAILURES: 14\nREVIEWERS: PASS\nUPGRADE_RESULT: SUCCESS";
  const cases: [string, boolean][] = [
    [`done\n${green}`, true],
    [`done\n${carried}`, true],
    [`done\n${green}\r\n`, true],
    [`done\n${green}\n\n`, true],
    [`I would print\n${green}\nbut tests fail.\nBASELINE_FAILURES: 0\nREVIEWERS: PASS\nUPGRADE_RESULT: FAILED`, false],
    ["BASELINE_FAILURES: 0\nREVIEWERS: FAIL\nUPGRADE_RESULT: SUCCESS", false],
    // Reviewers unresolved after impl-loop's 4-round cap: a green build must not carry it through.
    ["BASELINE_FAILURES: 2\nREVIEWERS: FAIL (1 Critical outstanding)\nUPGRADE_RESULT: SUCCESS", false],
    ["done\nREVIEWERS: PASS\nUPGRADE_RESULT: SUCCESS", false],
    ["done\nBASELINE_FAILURES: 0\nUPGRADE_RESULT: SUCCESS", false],
    // A count we can't read is not a zero: prBody would claim a green suite on a red one.
    ["BASELINE_FAILURES: some\nREVIEWERS: PASS\nUPGRADE_RESULT: SUCCESS", false],
    ["done\nUPGRADE_RESULT: SUCCESS", false],
    [`done\n${green.replace("SUCCESS", "FAILED")}`, false],
    ["End with UPGRADE_RESULT: SUCCESS if build and tests pass", false],
    ["", false],
  ];
  for (const [summary, want] of cases) {
    assert.strictEqual(verdict(summary).ok, want, JSON.stringify(summary));
  }
  const parsed = verdict(`done\n${carried}`);
  assert.strictEqual(parsed.ok && parsed.baselineFailures, 14, "the carried-failure count must reach prBody");
  const parsedGreen = verdict(green);
  // `ok &&` would read false as 0 here; assert the shape first so a zero count can't be faked by a
  // rejected verdict.
  assert.ok(parsedGreen.ok && parsedGreen.baselineFailures === 0, "a green run reports zero");

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
  // By value, not by name: the check above only proves the two names it knows about.
  assert.ok(
    !Object.values(childEnv(secret)).some((v) => v?.includes(secret)),
    "childEnv must withhold the token under ANY variable name",
  );

  // The PR body quotes untrusted agent text; it must not be able to escape the <details>.
  const hostile = "ok\n</details>\n\nFixes #1 cc @octocat";
  const body = prBody(hostile, secret, 0);
  assert.strictEqual(body.match(/<\/details>/g)?.length, 2, "summary must not close <details> early");
  assert.ok(/```text\n/.test(body), "summary must be fenced");
  assert.ok(prBody("a ``` b", secret, 0).includes("````text"), "fence must outrun backticks in the summary");
  assert.strictEqual(redact("abc", ""), "abc", "empty token must not shred the text");

  // A PR carrying pre-existing failures must say so above the fold, not only inside <details>, and
  // must not repeat the green-suite claim that no longer holds.
  const red = prBody(`done\n${carried}`, secret, 14);
  assert.ok(red.includes("14 test(s) were already failing"), "carried failures must be stated in the body");
  assert.ok(red.includes("- [ ] The 14 pre-existing test failure(s)"), "carried failures need a checklist item");
  assert.ok(!red.includes("`dotnet test` both pass"), "must not claim a green suite when 14 tests fail");
  const clean = prBody(`done\n${green}`, secret, 0);
  assert.ok(clean.includes("`dotnet test` both pass"), "a green run keeps the original claim");
  assert.ok(!clean.includes("pre-existing"), "a green run gets no extra checklist item");

  // The body follows the operator's PR template: a normal run must emit every section, and the
  // untrusted summary stays sealed in the fenced <details> (the hostile case above proves that).
  const templated = prBody(`done\n${green}`, secret, 0);
  for (const marker of [
    "## [Dotnet upgrade agent workflow.]()",
    "### `    Describe this PR    `",
    "### `    What is the problem we're trying to solve?    `",
    "### `    What changes have we introduced?    `",
    "#### `    Checklist    `",
    "### `    Follow up actions after merging PR    `",
  ]) {
    assert.ok(templated.includes(marker), `PR body must contain section: ${marker}`);
  }
  // The template scaffolding sits OUTSIDE the untrusted summary: hostile mentions/links land inside
  // the fenced <details>, never in the checklist or follow-up that render as live markdown.
  assert.ok(!body.split("</details>").at(-1)?.includes("@octocat"), "no untrusted text past the sealed <details>");

  // The credential git actually transmits is the base64 form; redacting only the raw token leaks it.
  const basic = Buffer.from(`x-access-token:${secret}`).toString("base64");
  assert.ok(!redact(`fatal: AUTHORIZATION: basic ${basic}`, secret).includes(basic), "redact the basic form");
  assert.ok(!redact(Buffer.from(secret).toString("base64"), secret).includes("c2Vj"), "redact the base64 token");
  assert.strictEqual(redact("a\u001b[2Kb\r\nc", secret), "a[2Kb\nc", "redact must strip control characters");

  // Staged-path gates: one real change required, and nothing that executes on the target's CI.
  assert.ok(ARTIFACT_PATH.test("src/obj/x.dll") && ARTIFACT_PATH.test("a/b.binlog"), "artifacts detected");
  assert.ok(!ARTIFACT_PATH.test("src/App.csproj"), "real sources are not artifacts");
  for (const p of [".github/workflows/ci.yml", "sub/.github/x.yml", ".claude/settings.json", ".env", ".gitattributes"]) {
    assert.ok(FORBIDDEN_PATH.test(p), `must refuse ${p}`);
  }
  assert.ok(!FORBIDDEN_PATH.test("src/global.json"), "ordinary sources must stay allowed");
  assert.ok(!REPO_NAME.test("../evil") && !REPO_NAME.test("a/b"), "repo names must not traverse");
  assert.ok(REPO_NAME.test("My.Repo-1_x"), "legitimate repo names must pass");

  // The critical one, against a real repo: after the agent has run, `git` inside the clone must
  // neither execute what that repo planted nor carry the credential. Both were live token-exfil
  // paths — a pre-commit hook reading GIT_CONFIG_VALUE_0 decodes straight to the org write token.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dotnet10-selfcheck-"));
  try {
    spawnSync("git", ["init", "-q", dir], { encoding: "utf8" });
    const marker = path.join(dir, "hook-ran");
    const hooks = path.join(dir, ".git", "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, "pre-commit"), `#!/bin/sh\nenv > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "f.txt"), "hi");

    git(["add", "f.txt"], dir, secret);
    git(["commit", "-m", "t"], dir, secret); // deliberately NOT --no-verify: this tests hooksPath
    assert.ok(!fs.existsSync(marker), "git must not execute a repo-planted hook");

    // Credential scoping: present only for the two calls that talk to the remote.
    const header = "http.https://github.com/.extraheader";
    assert.throws(() => git(["config", "--get", header], dir, secret), "local git calls must be credential-free");
    assert.ok(git(["config", "--get", header], dir, secret, true).includes("basic "), "remote calls must authenticate");

    // The operator's own ~/.gitconfig must not reach these calls: an insteadOf rule silently
    // reroutes the authenticated clone to SSH, and a credential.helper persists secrets to disk.
    assert.throws(() => git(["config", "--get", "url.ssh://git@github.com/.insteadOf"], dir, secret), "global config ignored");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // No hand-maintained tally: node:assert halts the process on the first failure, so reaching this
  // line already means every case above passed.
  console.log("upgrade self-check: all cases pass");
}
