import { Octokit } from "@octokit/rest";
import { buildInventory, upgradeQueue, type RepoReport } from "./inventory";
import { upgradeRepo, type UpgradeConfig } from "./upgrade";

const sub = process.argv[2];
if (sub !== "inventory" && sub !== "run") {
  console.error("usage: tsx src/main.ts <inventory|run>");
  process.exit(1);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`invalid ${name}: ${raw} (expected a non-negative number)`);
    process.exit(1);
  }
  return n;
}

const org = requireEnv("GITHUB_ORG");
const token = requireEnv("GITHUB_TOKEN");
const activeMonths = numEnv("ACTIVE_MONTHS", 12);

const octokit = new Octokit({ auth: token });

async function main(): Promise<number> {
  const reports = await buildInventory(octokit, { org, activeMonths });
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
    return 0;
  }

  // Built only on the run path: the inventory subcommand never needs (or touches) upgrade config.
  const config: UpgradeConfig = {
    org,
    token,
    workDir: process.env.WORK_DIR ?? "./work",
    timeoutMinutes: numEnv("CLAUDE_TIMEOUT_MINUTES", 90),
    loopConfigDir: process.env.LOOP_CONFIG_DIR,
  };
  const batch = queue.slice(0, numEnv("BATCH_SIZE", 3));
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

main().then(
  (code) => process.exit(code),
  (e) => {
    const message = e instanceof Error ? e.stack ?? e.message : String(e);
    // Keep in sync with redact() in upgrade.ts (module-internal there per the export contract).
    console.error(message.replaceAll(token, "***"));
    process.exit(1);
  },
);
