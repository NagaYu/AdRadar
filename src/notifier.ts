/**
 * notifier.ts
 * -------------------------------------------------------------------------
 * Outbound notifications for AdRadar.
 *
 * Takes the {@link NotificationItem}s produced by the diff and renders them as
 * rich messages for Slack (Block Kit) and/or Discord (Embeds), then POSTs them
 * to the configured incoming webhooks with axios.
 *
 * Both transports are best-effort and isolated: a failure delivering to Slack
 * never blocks Discord, and a single oversized payload is chunked so we stay
 * under each platform's block/embed limits.
 * -------------------------------------------------------------------------
 */

import axios, { AxiosError } from "axios";
import { computeDaysRunning } from "./storage.js";
import type {
  NotificationItem,
  RuntimeConfig,
  StoredAd,
} from "./types.js";

/** Slack hard-caps a message at 50 blocks; Discord at 10 embeds. */
const SLACK_MAX_ADS_PER_MESSAGE = 8;
const DISCORD_MAX_EMBEDS = 10;

/** Network timeout for webhook delivery. */
const WEBHOOK_TIMEOUT_MS = 15000;

export interface NotifyOutcome {
  slackSent: number;
  discordSent: number;
  errors: string[];
}

/**
 * Build the notification items (new + winners) from a diff, computing the
 * `daysRunning` for each at send time.
 */
export function buildNotificationItems(
  newAds: StoredAd[],
  winners: StoredAd[],
  nowIso: string = new Date().toISOString(),
): NotificationItem[] {
  const items: NotificationItem[] = [];

  for (const ad of newAds) {
    items.push({
      reason: "new",
      ad,
      daysRunning: computeDaysRunning(ad, nowIso),
    });
  }
  for (const ad of winners) {
    items.push({
      reason: "winner",
      ad,
      daysRunning: computeDaysRunning(ad, nowIso),
    });
  }

  return items;
}

/**
 * Deliver all items to every configured channel. Never throws — all failures
 * are collected into {@link NotifyOutcome.errors}.
 */
export async function notify(
  items: NotificationItem[],
  config: RuntimeConfig,
): Promise<NotifyOutcome> {
  const outcome: NotifyOutcome = { slackSent: 0, discordSent: 0, errors: [] };

  if (items.length === 0) return outcome;

  if (config.dryRun) {
    outcome.errors.push("dry-run: notifications suppressed");
    return outcome;
  }

  if (config.slackWebhookUrl) {
    try {
      outcome.slackSent = await sendSlack(
        items,
        config.slackWebhookUrl,
        config,
      );
    } catch (err) {
      outcome.errors.push(`slack: ${describeError(err)}`);
    }
  }

  if (config.discordWebhookUrl) {
    try {
      outcome.discordSent = await sendDiscord(
        items,
        config.discordWebhookUrl,
        config,
      );
    } catch (err) {
      outcome.errors.push(`discord: ${describeError(err)}`);
    }
  }

  if (!config.slackWebhookUrl && !config.discordWebhookUrl) {
    outcome.errors.push(
      "no webhook configured (set SLACK_WEBHOOK_URL or DISCORD_WEBHOOK_URL)",
    );
  }

  return outcome;
}

/* ====================================================================== *
 *  SLACK — Block Kit                                                      *
 * ====================================================================== */

interface SlackBlock {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

async function sendSlack(
  items: NotificationItem[],
  webhookUrl: string,
  config: RuntimeConfig,
): Promise<number> {
  let sent = 0;
  for (const chunk of chunkArray(items, SLACK_MAX_ADS_PER_MESSAGE)) {
    const blocks = buildSlackBlocks(chunk, config);
    await axios.post(
      webhookUrl,
      { blocks, unfurl_links: false, unfurl_media: false },
      {
        timeout: WEBHOOK_TIMEOUT_MS,
        headers: { "Content-Type": "application/json" },
      },
    );
    sent += chunk.length;
  }
  return sent;
}

function buildSlackBlocks(
  items: NotificationItem[],
  config: RuntimeConfig,
): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  const newCount = items.filter((i) => i.reason === "new").length;
  const winnerCount = items.filter((i) => i.reason === "winner").length;

  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: `📡 AdRadar — ${newCount} new · ${winnerCount} winner${winnerCount === 1 ? "" : "s"}`,
      emoji: true,
    },
  });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Tracking page \`${config.pageId}\` · winner threshold *${config.winnerThresholdDays}d*`,
      },
    ],
  });

  blocks.push({ type: "divider" });

  for (const item of items) {
    const { ad, reason, daysRunning } = item;
    const badge = reason === "winner" ? "🏆 *LONG-RUNNING WINNER*" : "🆕 *NEW AD*";
    const advertiser = ad.pageName ? ` · *${escapeSlack(ad.pageName)}*` : "";
    const started = ad.startedRunningRaw
      ? escapeSlack(ad.startedRunningRaw)
      : "start date unknown";

    const copy = truncate(ad.text || "_(no body copy detected)_", 600);

    const section: SlackBlock = {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `${badge}${advertiser}`,
          `> ${escapeSlack(copy).replace(/\n/g, "\n> ")}`,
          `🗓️ ${started}  ·  ⏱️ running *${daysRunning}d*  ·  \`${ad.adId}\``,
        ].join("\n"),
      },
    };

    const thumb = pickThumbnail(ad);
    if (thumb) {
      section.accessory = {
        type: "image",
        image_url: thumb,
        alt_text: ad.pageName ? `${ad.pageName} creative` : "ad creative",
      };
    }

    blocks.push(section);

    if (ad.adLibraryUrl) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "🔗 Open in Ad Library", emoji: true },
            url: ad.adLibraryUrl,
          },
        ],
      });
    }

    blocks.push({ type: "divider" });
  }

  return blocks;
}

/* ====================================================================== *
 *  DISCORD — Embeds                                                       *
 * ====================================================================== */

interface DiscordEmbed {
  title: string;
  description?: string;
  url?: string;
  color: number;
  timestamp?: string;
  footer?: { text: string };
  author?: { name: string };
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  image?: { url: string };
  thumbnail?: { url: string };
}

async function sendDiscord(
  items: NotificationItem[],
  webhookUrl: string,
  config: RuntimeConfig,
): Promise<number> {
  let sent = 0;
  for (const chunk of chunkArray(items, DISCORD_MAX_EMBEDS)) {
    const embeds = chunk.map((item) => buildDiscordEmbed(item, config));
    await axios.post(
      webhookUrl,
      {
        username: "AdRadar",
        content: discordSummaryLine(chunk, config),
        embeds,
      },
      {
        timeout: WEBHOOK_TIMEOUT_MS,
        headers: { "Content-Type": "application/json" },
      },
    );
    sent += chunk.length;
  }
  return sent;
}

function discordSummaryLine(
  items: NotificationItem[],
  config: RuntimeConfig,
): string {
  const newCount = items.filter((i) => i.reason === "new").length;
  const winnerCount = items.filter((i) => i.reason === "winner").length;
  return `📡 **AdRadar** — ${newCount} new · ${winnerCount} winner(s) for page \`${config.pageId}\``;
}

function buildDiscordEmbed(
  item: NotificationItem,
  config: RuntimeConfig,
): DiscordEmbed {
  const { ad, reason, daysRunning } = item;
  const isWinner = reason === "winner";

  const embed: DiscordEmbed = {
    title: isWinner
      ? "🏆 Long-running winner"
      : "🆕 New ad detected",
    color: isWinner ? 0xf5a623 /* gold */ : 0x2eb67d /* green */,
    description: truncate(ad.text || "*(no body copy detected)*", 2000),
    timestamp: new Date().toISOString(),
    footer: {
      text: `AdRadar · page ${config.pageId} · winner ≥ ${config.winnerThresholdDays}d`,
    },
    fields: [
      {
        name: "Started running",
        value: ad.startedRunningRaw ?? "unknown",
        inline: true,
      },
      {
        name: "Days running",
        value: `${daysRunning}d`,
        inline: true,
      },
      {
        name: "Ad ID",
        value: `\`${ad.adId}\``,
        inline: true,
      },
    ],
  };

  if (ad.pageName) embed.author = { name: ad.pageName };
  if (ad.adLibraryUrl) embed.url = ad.adLibraryUrl;

  const thumb = pickThumbnail(ad);
  if (thumb) embed.image = { url: thumb };

  return embed;
}

/* ====================================================================== *
 *  Shared helpers                                                         *
 * ====================================================================== */

/**
 * Choose the best preview image for an ad: a real image first, then a video's
 * poster frame, then any media URL as a last resort.
 */
function pickThumbnail(ad: StoredAd): string | null {
  const image = ad.media.find((m) => m.type === "image");
  if (image) return image.url;

  const videoWithPoster = ad.media.find(
    (m) => m.type === "video" && m.thumbnailUrl,
  );
  if (videoWithPoster?.thumbnailUrl) return videoWithPoster.thumbnailUrl;

  const any = ad.media[0];
  return any ? any.thumbnailUrl ?? any.url : null;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Escape Slack mrkdwn control characters. */
function escapeSlack(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function describeError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const ax = err as AxiosError;
    const status = ax.response?.status;
    const body =
      typeof ax.response?.data === "string"
        ? ax.response.data
        : JSON.stringify(ax.response?.data ?? {});
    return `HTTP ${status ?? "?"} ${ax.message} ${body}`.trim();
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
