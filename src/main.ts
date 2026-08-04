import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { buildInventory, upgradeQueue, type RepoReport } from "./inventory";
import { redact, upgradeRepo, type UpgradeConfig } from "./upgrade";

const sub = process.argv[2];
if (sub !== "inventory" && sub !== "run") {
  console.error("usage: tsx src/main.ts <inventory|run>");
  process.exit(1);
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

// `min` defaults to 1: every one of these knobs counts something, and 0 is never the value an
// operator means. CLAUDE_TIMEOUT_MINUTES=0 is the dangerous one — spawnSync reads timeout:0 as
// "no timeout" and would run the agent on untrusted code forever. BATCH_SIZE=0 is the quiet one:
// it reports "0/0 PRs opened" and exits 0, so a misconfigured CI job looks like a clean success.
function numEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    console.error(`invalid ${name}: ${raw} (expected an integer >= ${min})`);
    process.exit(1);
  }
  return n;
}

const org = requireEnv("GITHUB_ORG");
// Interpolated into a clone URL and into API paths. GitHub's own charset for logins; catching a
// stray quote or newline from a hand-edited .env here beats failing deep inside git.
if (!/^[A-Za-z0-9-]+$/.test(org)) {
  console.error(`invalid GITHUB_ORG: ${JSON.stringify(org)}`);
  process.exit(1);
}
const token = requireEnv("GITHUB_TOKEN");
const activeMonths = numEnv("ACTIVE_MONTHS", 12);
// "0" and unset both mean no filter: the whole org, as before. Any other value keeps only the repos
// whose CODEOWNERS names that owner — both in the inventory print and in what `run` upgrades.
const rawOwner = process.env.CODE_OWNERS?.trim();
const codeOwner = !rawOwner || rawOwner === "0" ? undefined : rawOwner;

// A full-org scan is one getTree plus up to 30 getContent per repo, so a few hundred repos will
// trip GitHub's secondary rate limit. Without these plugins the 403 propagates out of
// buildInventory and kills the whole run mid-scan; with them it waits and resumes.
const ThrottledOctokit = Octokit.plugin(retry, throttling);
const retryLimit = 3;
const octokit = new ThrottledOctokit({
  auth: token,
  throttle: {
    onRateLimit: (retryAfter, opts, _octokit, retryCount) => {
      console.error(`rate limit on ${opts.method} ${opts.url}; retry ${retryCount + 1} in ${retryAfter}s`);
      return retryCount < retryLimit;
    },
    onSecondaryRateLimit: (retryAfter, opts, _octokit, retryCount) => {
      console.error(`secondary rate limit on ${opts.method} ${opts.url}; retry ${retryCount + 1} in ${retryAfter}s`);
      return retryCount < retryLimit;
    },
  },
});

async function main(): Promise<number> {
  const reports = await buildInventory(octokit, { org, activeMonths, codeOwner });
  const queue = upgradeQueue(reports);

  if (sub === "inventory") {
    console.log(`Upgrade queue (${queue.length}):`);
    for (const r of queue) {
      const targets = r.tfms.concat(r.sdkVersion ? [`sdk ${r.sdkVersion}`] : []).join(", ") || "(none)";
      console.log(`  ${r.name}  [${targets}]  ${r.projectFileCount} project file(s)  last push ${r.pushedAt.slice(0, 10)}`);
    }
    const names = (c: RepoReport["classification"]) =>
      reports.filter((r) => r.classification === c).map((r) => r.name).join(", ") || "(none)";
    console.log(`Excluded — .NET Framework: ${names("framework")}`);
    console.log(`Excluded — netstandard-only: ${names("netstandard-only")}`);
    console.log(`Excluded — incomplete scan: ${names("incomplete")}`);
    return 0;
  }

  // Built only on the run path: the inventory subcommand never needs (or touches) upgrade config.
  const config: UpgradeConfig = {
    org,
    token,
    // `||` not `??`: WORK_DIR= in a .env is an empty string, which resolves to the process cwd and
    // would point the clone-and-rm-rf at this repo. upgradeRepo re-checks the resolved path.
    workDir: process.env.WORK_DIR?.trim() || "./work",
    timeoutMinutes: numEnv("CLAUDE_TIMEOUT_MINUTES", 90),
    loopConfigDir: process.env.LOOP_CONFIG_DIR,
  };
  const batch = queue.slice(0, numEnv("BATCH_SIZE", 4));
  let ok = 0;
  for (const r of batch) {
    console.log(`upgrading ${r.name}...`);
    const outcome = await upgradeRepo(octokit, config, r);
    if (outcome.ok) {
      ok++;
      console.log(`${r.name}: PR opened ${outcome.prUrl}`);
    } else {
      const log = outcome.logPath ? ` (log: ${outcome.logPath})` : "";
      console.error(`${r.name}: failed — ${outcome.reason}${log}`);
    }
  }
  console.log(`${ok}/${batch.length} PRs opened`);
  return ok === batch.length ? 0 : 1;
}

const die = (e: unknown) => {
  const message = e instanceof Error ? e.stack ?? e.message : String(e);
  console.error(redact(message, token));
  process.exit(1);
};
// Anything escaping main()'s promise chain — an octokit socket error, a throw inside a throttle
// hook — would otherwise print Node's default unredacted stack, token and all.
process.on("unhandledRejection", die);
process.on("uncaughtException", die);

main().then((code) => process.exit(code), die);
