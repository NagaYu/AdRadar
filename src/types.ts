/**
 * types.ts
 * -------------------------------------------------------------------------
 * Central, strict type definitions for AdRadar.
 *
 * Everything that crosses a module boundary (scraper -> storage -> notifier)
 * is described here so that the compiler — with `strict: true` — can catch
 * shape mismatches before they ever reach the Meta Ad Library DOM.
 * -------------------------------------------------------------------------
 */

/**
 * The kind of media attached to an ad creative.
 */
export type CreativeMediaType = "image" | "video" | "unknown";

/**
 * A single media asset extracted from an ad card.
 */
export interface CreativeMedia {
  /** "image" | "video" | "unknown" */
  type: CreativeMediaType;
  /** Direct URL to the asset (CDN image, mp4, or poster frame). */
  url: string;
  /**
   * For videos, the poster/thumbnail frame if Meta exposes one separately.
   * Used by the notifier to render a preview even for video creatives.
   */
  thumbnailUrl?: string;
}

/**
 * A normalized advertisement, as produced by the scraper.
 *
 * This is the canonical "wire" shape. The storage layer enriches it with
 * tracking metadata (see {@link StoredAd}).
 */
export interface Ad {
  /**
   * Stable identifier for the ad. Meta exposes a "Library ID" per ad; when it
   * is missing we synthesize a deterministic hash from the ad's content so the
   * diffing logic still has something stable to key on.
   */
  adId: string;

  /** Raw "Started running on ..." string exactly as scraped (for display). */
  startedRunningRaw: string | null;

  /**
   * Parsed ISO-8601 date (YYYY-MM-DD) of when the ad started running, if we
   * were able to parse {@link startedRunningRaw}; otherwise null.
   */
  startedRunningOn: string | null;

  /** The main body copy / primary text of the ad. */
  text: string;

  /** Zero or more media assets attached to the creative. */
  media: CreativeMedia[];

  /**
   * The "Sponsored" / page display name shown on the card, when available.
   * Useful for multi-page libraries and for nicer notifications.
   */
  pageName: string | null;

  /** The permalink to this specific ad in the Ad Library, when resolvable. */
  adLibraryUrl: string | null;

  /** Whether Meta still marks the ad as "Active" at scrape time. */
  active: boolean;
}

/**
 * An {@link Ad} after it has been persisted at least once. The storage layer
 * stamps it with first/last-seen timestamps so trend detection is possible.
 */
export interface StoredAd extends Ad {
  /** ISO timestamp when AdRadar first observed this ad. */
  firstSeenAt: string;
  /** ISO timestamp of the most recent run that observed this ad. */
  lastSeenAt: string;
  /** How many distinct runs have observed this ad. */
  seenCount: number;
  /**
   * True once we have fired the "long-running winner" notification, so we do
   * not spam the same evergreen ad on every single run.
   */
  notifiedAsWinner: boolean;
}

/**
 * The on-disk snapshot schema. Versioned so future migrations are painless.
 */
export interface Snapshot {
  /** Schema version of this snapshot file. */
  version: 1;
  /** The page id / library identifier this snapshot tracks. */
  pageId: string;
  /** ISO timestamp of the last successful run. */
  updatedAt: string;
  /** Map of adId -> StoredAd. */
  ads: Record<string, StoredAd>;
}

/**
 * The result of reconciling a fresh scrape against the previous snapshot.
 */
export interface DiffResult {
  /** Ads observed for the very first time on this run. */
  newAds: StoredAd[];
  /**
   * Ads that have been active for >= the winner threshold and have not yet
   * been announced as winners.
   */
  longRunningWinners: StoredAd[];
  /** Ads seen previously and again now (not new, not newly-winning). */
  stillRunning: StoredAd[];
  /** The full, merged snapshot to be written back to disk. */
  snapshot: Snapshot;
}

/**
 * Why a given ad is being announced. Drives the headline/emoji in notifiers.
 */
export type NotificationReason = "new" | "winner";

/**
 * A single notification payload item — one ad worth telling the user about.
 */
export interface NotificationItem {
  reason: NotificationReason;
  ad: StoredAd;
  /** Days the ad has been running, computed at notification time. */
  daysRunning: number;
}

/**
 * Supported outbound notification channels.
 */
export type WebhookKind = "slack" | "discord";

/**
 * Fully-resolved runtime configuration, after merging CLI flags and env vars.
 */
export interface RuntimeConfig {
  /** The Facebook page id OR a full Ad Library URL. */
  pageId: string;
  /** The resolved Ad Library URL we will actually navigate to. */
  targetUrl: string;
  /** ISO country code passed to the Ad Library (e.g. "US", "ALL"). */
  country: string;
  /** Where the snapshot JSON lives. */
  dataFile: string;
  /** Days an ad must run before it counts as a "winner". */
  winnerThresholdDays: number;
  /** Max number of infinite-scroll passes before we give up. */
  maxScrolls: number;
  /** Run the browser headless? */
  headless: boolean;
  /** Slack incoming webhook URL, if configured. */
  slackWebhookUrl: string | null;
  /** Discord webhook URL, if configured. */
  discordWebhookUrl: string | null;
  /** Skip every outbound notification (dry run). */
  dryRun: boolean;
  /** Per-navigation timeout in milliseconds. */
  navigationTimeoutMs: number;
}
