import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import type { Octokit } from "@octokit/rest";

export type RepoReport = {
  name: string;
  defaultBranch: string;
  pushedAt: string;
  classification:
    | "needs-upgrade"
    | "up-to-date"
    | "framework"
    | "netstandard-only"
    | "no-dotnet"
    /** Evidence was incomplete (truncated tree, too many or too large project files). Never queued. */
    | "incomplete";
  tfms: string[];
  sdkVersion?: string;
  projectFileCount: number;
};

type InventoryOpts = { org: string; activeMonths: number };

const PROJECT_FILE = /\.(cs|fs|vb)proj$/i;
const SPECIAL_FILE = /(^|\/)(Directory\.Build\.props|global\.json)$/i;
const isInteresting = (p: string) => PROJECT_FILE.test(p) || SPECIAL_FILE.test(p);
const MAX_FETCHES_PER_REPO = 30;
// getContent serves blobs up to 100 MB and we fetch 30 concurrently; without a cap one repo of
// padded .csproj files OOMs the scan. Real project files are kilobytes.
const MAX_FILE_BYTES = 1_000_000;
// The TFM regex is quadratic on input like "<TargetFramework ".repeat(n) with no closing ">".
// The size cap above already bounds it; this bounds it to milliseconds.
const MAX_PARSE_CHARS = 200_000;

export async function buildInventory(octokit: Octokit, opts: InventoryOpts): Promise<RepoReport[]> {
  // Day 1 before the shift: setMonth() on a 31st rolls forward into the wrong month
  // (Mar 31 minus 1 month lands on Mar 3). Erring wider never drops an active repo.
  const cutoff = new Date();
  cutoff.setDate(1);
  cutoff.setMonth(cutoff.getMonth() - opts.activeMonths);
  const repos = await octokit.paginate(octokit.repos.listForOrg, { org: opts.org, per_page: 100 });
  // Sequential per repo; inspectRepo's own Promise.all already parallelizes the ≤31 fetches within one.
  const reports: RepoReport[] = [];
  for (const repo of repos) {
    // No default branch means an empty repo — skip rather than guess a branch name.
    if (repo.archived || repo.disabled || !repo.default_branch) continue;
    if (!repo.pushed_at || new Date(repo.pushed_at) < cutoff) continue;
    reports.push(await inspectRepo(octokit, opts.org, repo.name, repo.default_branch, repo.pushed_at));
  }
  return reports;
}

export function upgradeQueue(reports: RepoReport[]): RepoReport[] {
  return reports
    .filter((r) => r.classification === "needs-upgrade")
    .sort((a, b) => a.projectFileCount - b.projectFileCount);
}

async function inspectRepo(
  octokit: Octokit,
  org: string,
  name: string,
  defaultBranch: string,
  pushedAt: string,
): Promise<RepoReport> {
  let paths: string[] = [];
  let projectFileCount = 0;
  let incomplete = false;
  try {
    const { data } = await octokit.git.getTree({ owner: org, repo: name, tree_sha: defaultBranch, recursive: "1" });
    if (data.truncated) console.error(`warning: ${name}: git tree truncated; classification may be incomplete`);
    const blobs = data.tree.filter((e) => e.type === "blob");
    projectFileCount = blobs.filter((e) => PROJECT_FILE.test(e.path ?? "")).length;
    const interesting = blobs.filter((e) => isInteresting(e.path ?? ""));
    const readable = interesting.filter((e) => (e.size ?? 0) <= MAX_FILE_BYTES);
    paths = readable.map((e) => e.path ?? "").slice(0, MAX_FETCHES_PER_REPO);
    // Any evidence we did not actually read makes the verdict a guess: see the classification below.
    incomplete = Boolean(data.truncated) || readable.length < interesting.length || paths.length < readable.length;
  } catch (e) {
    // 409 empty repo / 404 unreadable ref: genuinely no project files. Anything else (auth, rate limit) must surface.
    const status = (e as { status?: number }).status;
    if (status !== 404 && status !== 409) throw e;
  }

  const tfms: string[] = [];
  let sdkVersion: string | undefined;
  const texts = await Promise.all(paths.map((p) => fetchText(octokit, org, name, p, defaultBranch)));
  // Parse in path order so "last global.json wins" stays deterministic.
  for (const [i, p] of paths.entries()) {
    const text = texts[i]?.slice(0, MAX_PARSE_CHARS);
    if (text === undefined) continue;
    if (/global\.json$/i.test(p)) {
      try {
        // JSON.parse yields anything; sdkVersion is typed string and gets printed and parseInt'd.
        const v = JSON.parse(text)?.sdk?.version;
        if (typeof v === "string") sdkVersion = v;
      } catch {
        // malformed global.json: ignore
      }
    } else {
      for (const m of text.matchAll(/<TargetFrameworks?(?:\s[^>]*)?>([^<]+)<\/TargetFrameworks?>/gi)) {
        tfms.push(...m[1].split(";").map((t) => t.trim()).filter(Boolean));
      }
    }
  }

  const classification = classify(tfms, sdkVersion);
  return {
    name,
    defaultBranch,
    pushedAt,
    // Partial evidence must not reach the write path. A repo whose net472 projects fell outside the
    // fetched slice looks exactly like a clean net8.0 upgrade candidate — and padding a repo with
    // junk files to push the real TFMs past the cap is a cheap way to aim the agent at it.
    // Only the upgrade verdict is withheld; "up-to-date" and the excluded buckets are safe to keep.
    classification: incomplete && classification === "needs-upgrade" ? "incomplete" : classification,
    tfms: [...new Set(tfms)],
    sdkVersion,
    projectFileCount,
  };
}

async function fetchText(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | undefined> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref, mediaType: { format: "raw" } });
    return typeof data === "string" ? data : undefined;
  } catch (e) {
    // 404: file deleted between tree read and fetch. Anything else (auth, rate limit) must surface.
    if ((e as { status?: number }).status === 404) return undefined;
    throw e;
  }
}

function classify(tfms: string[], sdkVersion: string | undefined): RepoReport["classification"] {
  if (tfms.some((t) => /^net4\d/i.test(t))) return "framework";
  const majors: number[] = [];
  for (const t of tfms) {
    const m = /^net(coreapp)?(\d+)\.\d+/i.exec(t);
    if (m && (m[1] || Number(m[2]) >= 5)) majors.push(Number(m[2]));
  }
  const sdkMajor = parseInt(sdkVersion ?? "", 10);
  if (!Number.isNaN(sdkMajor)) majors.push(sdkMajor);
  if (majors.length) return Math.max(...majors) >= 10 ? "up-to-date" : "needs-upgrade";
  return tfms.some((t) => /^netstandard/i.test(t)) ? "netstandard-only" : "no-dotnet";
}

// Minimal runnable self-check for the classifier (acceptance criterion 6.2):
//   npx tsx src/inventory.ts
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const cases: [string[], string | undefined, RepoReport["classification"]][] = [
    [["net8.0"], undefined, "needs-upgrade"],
    [["net8.0-windows"], undefined, "needs-upgrade"],
    [["netcoreapp3.1"], undefined, "needs-upgrade"],
    [[], "8.0.100", "needs-upgrade"],
    [["net10.0"], undefined, "up-to-date"],
    [["net8.0", "net10.0"], undefined, "up-to-date"],
    [["net472"], undefined, "framework"],
    [["netstandard2.0"], undefined, "netstandard-only"],
    [[], undefined, "no-dotnet"],
  ];
  for (const [tfms, sdk, want] of cases) {
    assert.strictEqual(classify(tfms, sdk), want, `classify(${JSON.stringify(tfms)}, ${JSON.stringify(sdk)})`);
  }

  // The TFM regex must not blow up on a padded project file — the cap keeps this well under a second.
  const started = Date.now();
  const hostile = "<TargetFramework ".repeat(MAX_PARSE_CHARS).slice(0, MAX_PARSE_CHARS);
  assert.strictEqual([...hostile.matchAll(/<TargetFrameworks?(?:\s[^>]*)?>([^<]+)<\/TargetFrameworks?>/gi)].length, 0);
  assert.ok(Date.now() - started < 5_000, "TFM parse must stay bounded on hostile input");

  // Incomplete evidence must never produce a queued repo.
  const queued = upgradeQueue([
    { name: "a", defaultBranch: "main", pushedAt: "", classification: "needs-upgrade", tfms: [], projectFileCount: 1 },
    { name: "b", defaultBranch: "main", pushedAt: "", classification: "incomplete", tfms: [], projectFileCount: 1 },
  ]);
  assert.deepStrictEqual(queued.map((r) => r.name), ["a"], "incomplete repos must not be queued");

  const checks = cases.length + 3;
  console.log(`classification self-check: ${checks}/${checks} cases pass`);
}
