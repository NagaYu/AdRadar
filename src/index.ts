#!/usr/bin/env node
/**
 * index.ts
 * -------------------------------------------------------------------------
 * AdRadar CLI entry point.
 *
 * Wires together the four pillars:
 *   scraper  -> pull the competitor's live ads from the Meta Ad Library
 *   storage  -> diff against the last snapshot, detect new + winner ads
 *   notifier -> push rich alerts to Slack / Discord
 *   (this)   -> argument parsing + a pretty, colorful progress narrative
 *
 * Exit codes:
 *   0  success (with or without findings)
 *   1  a hard failure (bad args, scrape crash, unwritable snapshot)
 * -------------------------------------------------------------------------
 */

import { Command } from "commander";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import {
  bold,
  cyan,
  dim,
  green,
  magenta,
  red,
  yellow,
} from "colorette";
import { resolveTargetUrl, scrapeAdLibrary } from "./scraper.js";
import { loadSnapshot, reconcile, saveSnapshot, computeDaysRunning } from "./storage.js";
import { buildNotificationItems, notify } from "./notifier.js";
import type { RuntimeConfig, StoredAd } from "./types.js";

loadEnv();

const VERSION = "1.0.0";

interface CliOptions {
  pageId?: string;
  url?: string;
  country: string;
  data: string;
  winnerDays: string;
  maxScrolls: string;
  headless: boolean;
  slackWebhook?: string;
  discordWebhook?: string;
  dryRun: boolean;
  timeout: string;
  quiet: boolean;
}

function buildProgram(): Command {
  const program = new Command();

  program
    .name("adradar")
    .description(
      "Radar for your competitors' Meta (Facebook) ads — scrape the Ad Library, " +
        "detect new creatives & long-running winners, and alert Slack/Discord.",
    )
    .version(VERSION, "-v, --version", "print the AdRadar version")
    .option("-p, --page-id <id>", "Facebook page id to monitor")
    .option("-u, --url <url>", "full Ad Library URL (overrides --page-id)")
    .option("-c, --country <code>", "Ad Library country filter (e.g. US, ALL)", "ALL")
    .option("-d, --data <file>", "path to the snapshot JSON", "data/snapshot.json")
    .option("-w, --winner-days <n>", "days running to qualify as a winner", "7")
    .option("-s, --max-scrolls <n>", "max infinite-scroll passes", "40")
    .option("--no-headless", "run with a visible browser window")
    .option("--slack-webhook <url>", "Slack incoming webhook (or SLACK_WEBHOOK_URL)")
    .option("--discord-webhook <url>", "Discord webhook (or DISCORD_WEBHOOK_URL)")
    .option("--dry-run", "scrape & diff but send no notifications", false)
    .option("--timeout <ms>", "per-navigation timeout in ms", "60000")
    .option("-q, --quiet", "suppress progress chatter", false);

  return program;
}

/**
 * Merge CLI flags + environment into a fully-resolved {@link RuntimeConfig},
 * validating required inputs along the way.
 */
function resolveConfig(opts: CliOptions): RuntimeConfig {
  const rawPage = opts.url ?? opts.pageId ?? process.env["ADRADAR_PAGE_ID"];

  if (!rawPage || rawPage.trim().length === 0) {
    throw new UsageError(
      "Missing target. Provide --page-id <id> or --url <adLibraryUrl> " +
        "(or set ADRADAR_PAGE_ID).",
    );
  }

  const winnerThresholdDays = toPositiveInt(opts.winnerDays, "winner-days");
  const maxScrolls = toPositiveInt(opts.maxScrolls, "max-scrolls");
  const navigationTimeoutMs = toPositiveInt(opts.timeout, "timeout");

  const pageId = opts.url ? opts.url.trim() : rawPage.trim();
  const targetUrl = resolveTargetUrl(rawPage, opts.country);

  return {
    pageId,
    targetUrl,
    country: opts.country,
    dataFile: resolve(process.cwd(), opts.data),
    winnerThresholdDays,
    maxScrolls,
    headless: opts.headless,
    slackWebhookUrl:
      opts.slackWebhook ?? process.env["SLACK_WEBHOOK_URL"] ?? null,
    discordWebhookUrl:
      opts.discordWebhook ?? process.env["DISCORD_WEBHOOK_URL"] ?? null,
    dryRun: opts.dryRun,
    navigationTimeoutMs,
  };
}

class UsageError extends Error {}

function toPositiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new UsageError(`--${name} must be a positive integer (got "${value}")`);
  }
  return n;
}

/* ---------------------------------------------------------------------- *
 *  Main orchestration                                                     *
 * ---------------------------------------------------------------------- */

async function run(config: RuntimeConfig, quiet: boolean): Promise<number> {
  const log = quiet ? () => {} : (msg: string) => process.stderr.write(msg + "\n");
  const progress = (msg: string) => log(`  ${dim("›")} ${msg}`);

  banner(log);

  log(bold(cyan("\n▸ Target")));
  log(`  page/url : ${magenta(config.pageId)}`);
  log(`  country  : ${config.country}`);
  log(`  url      : ${dim(config.targetUrl)}`);
  log(`  snapshot : ${dim(config.dataFile)}`);
  log(
    `  winner≥  : ${config.winnerThresholdDays}d   maxScrolls: ${config.maxScrolls}   headless: ${config.headless}`,
  );

  /* --- 1) Scrape ----------------------------------------------------- */
  log(bold(cyan("\n▸ Scraping Meta Ad Library")));
  const startedAt = Date.now();
  const ads = await scrapeAdLibrary(config, progress);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (ads.length === 0) {
    log(yellow(`  ⚠ No active ads found (took ${elapsed}s).`));
    log(
      dim(
        "    The page may have no live ads, be region-restricted, or Meta " +
          "changed its DOM. Try --no-headless to watch the run.",
      ),
    );
  } else {
    log(green(`  ✓ Scraped ${bold(String(ads.length))} active ad(s) in ${elapsed}s`));
  }

  /* --- 2) Diff against the last snapshot ----------------------------- */
  log(bold(cyan("\n▸ Reconciling against snapshot")));
  const previous = await loadSnapshot(config.dataFile, config.pageId);
  const priorCount = Object.keys(previous.ads).length;
  log(dim(`  loaded ${priorCount} previously-tracked ad(s)`));

  const nowIso = new Date().toISOString();
  const diff = reconcile(ads, previous, config.winnerThresholdDays, nowIso);

  log(
    `  ${green(`🆕 ${diff.newAds.length} new`)}  ·  ` +
      `${yellow(`🏆 ${diff.longRunningWinners.length} winner(s)`)}  ·  ` +
      `${dim(`${diff.stillRunning.length} still running`)}`,
  );

  printFindings(log, diff.newAds, "NEW", nowIso);
  printFindings(log, diff.longRunningWinners, "WINNER", nowIso);

  /* --- 3) Persist the merged snapshot -------------------------------- */
  await saveSnapshot(config.dataFile, diff.snapshot);
  log(dim(`\n  💾 Snapshot written (${Object.keys(diff.snapshot.ads).length} ad(s) tracked)`));

  /* --- 4) Notify ----------------------------------------------------- */
  const items = buildNotificationItems(
    diff.newAds,
    diff.longRunningWinners,
    nowIso,
  );

  if (items.length === 0) {
    log(dim("\n▸ Nothing new to announce. Radar is quiet. 😴"));
    return 0;
  }

  log(bold(cyan("\n▸ Dispatching notifications")));
  const outcome = await notify(items, config);

  if (outcome.slackSent > 0) log(green(`  ✓ Slack: ${outcome.slackSent} ad(s)`));
  if (outcome.discordSent > 0) log(green(`  ✓ Discord: ${outcome.discordSent} ad(s)`));
  for (const err of outcome.errors) {
    // dry-run / no-webhook are informational, real failures are warnings.
    if (err.startsWith("dry-run") || err.startsWith("no webhook")) {
      log(dim(`  ⓘ ${err}`));
    } else {
      log(red(`  ✗ ${err}`));
    }
  }

  log(green(bold("\n✓ AdRadar sweep complete.\n")));
  return 0;
}

function printFindings(
  log: (msg: string) => void,
  ads: StoredAd[],
  label: "NEW" | "WINNER",
  nowIso: string,
): void {
  if (ads.length === 0) return;
  const tag = label === "WINNER" ? yellow("🏆 WINNER") : green("🆕 NEW");
  for (const ad of ads) {
    const days = computeDaysRunning(ad, nowIso);
    const name = ad.pageName ? bold(ad.pageName) : dim("(unknown advertiser)");
    const preview = (ad.text || "(no copy)").replace(/\s+/g, " ").slice(0, 90);
    log(`    ${tag} ${name} ${dim(`[${ad.adId}]`)} ${dim(`${days}d`)}`);
    log(`        ${dim("“" + preview + (preview.length >= 90 ? "…" : "") + "”")}`);
    if (ad.media[0]) log(`        ${dim("media: " + ad.media[0].url.slice(0, 96))}`);
  }
}

function banner(log: (msg: string) => void): void {
  log(
    magenta(
      bold("\n  ╔═══════════════════════════════════════╗"),
    ),
  );
  log(magenta(bold("  ║          📡  A D R A D A R            ║")));
  log(
    magenta(
      bold("  ╚═══════════════════════════════════════╝"),
    ),
  );
  log(dim("  Competitive Meta-ad radar · new & winner detection"));
}

/* ---------------------------------------------------------------------- *
 *  Bootstrap                                                              *
 * ---------------------------------------------------------------------- */

async function main(): Promise<void> {
  const program = buildProgram();
  program.parse(process.argv);
  const opts = program.opts<CliOptions>();

  try {
    const config = resolveConfig(opts);
    const code = await run(config, opts.quiet);
    process.exit(code);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(red(`\n✗ ${err.message}\n\n`));
      program.outputHelp();
      process.exit(1);
    }
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(red(`\n✗ AdRadar failed:\n${message}\n`));
    process.exit(1);
  }
}

void main();
