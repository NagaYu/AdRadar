/**
 * storage.ts
 * -------------------------------------------------------------------------
 * AdRadar's tiny file-based "database".
 *
 * We persist a single JSON snapshot per page id. On every run we reconcile the
 * fresh scrape against that snapshot to answer two questions:
 *
 *   1. Which ads are brand new?               -> {@link DiffResult.newAds}
 *   2. Which ads have been running >= N days  -> {@link DiffResult.longRunningWinners}
 *      and therefore look like proven winners?
 *
 * The store is intentionally dependency-free (just `node:fs`) so AdRadar can
 * run in a bare GitHub Actions runner with nothing to provision.
 * -------------------------------------------------------------------------
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { Ad, DiffResult, Snapshot, StoredAd } from "./types.js";

const SNAPSHOT_VERSION = 1 as const;

/**
 * Read the snapshot for `pageId` from `filePath`. If the file does not exist,
 * is empty, or is corrupt, we transparently return a fresh, empty snapshot so
 * the very first run "just works".
 */
export async function loadSnapshot(
  filePath: string,
  pageId: string,
): Promise<Snapshot> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) return emptySnapshot(pageId);

    const parsed = JSON.parse(raw) as Partial<Snapshot>;

    // Defensive validation — never trust on-disk data blindly.
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.ads !== "object" ||
      parsed.ads === null
    ) {
      return emptySnapshot(pageId);
    }

    return {
      version: SNAPSHOT_VERSION,
      pageId: parsed.pageId ?? pageId,
      updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
      ads: parsed.ads as Record<string, StoredAd>,
    };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      // First ever run for this page — that's expected, not an error.
      return emptySnapshot(pageId);
    }
    // Corrupt JSON or unreadable file: warn via thrown context, but degrade
    // gracefully so a single bad write never bricks the tool permanently.
    if (err instanceof SyntaxError) {
      return emptySnapshot(pageId);
    }
    throw err;
  }
}

function emptySnapshot(pageId: string): Snapshot {
  return {
    version: SNAPSHOT_VERSION,
    pageId,
    updatedAt: new Date(0).toISOString(),
    ads: {},
  };
}

/**
 * Atomically persist a snapshot. We write to a temp file then rename so a
 * crash mid-write never leaves a half-written, corrupt JSON behind.
 */
export async function saveSnapshot(
  filePath: string,
  snapshot: Snapshot,
): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  const serialized = JSON.stringify(snapshot, null, 2);
  await fs.writeFile(tmp, serialized, "utf8");
  await fs.rename(tmp, filePath);
}

/**
 * Whole-number day delta between two ISO datetimes (b - a), floored.
 */
export function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

/**
 * Compute the number of days an ad has been running, preferring Meta's own
 * "Started running on" date when we parsed it, and falling back to the date we
 * first observed the ad ourselves.
 */
export function computeDaysRunning(ad: StoredAd, nowIso: string): number {
  const anchor = ad.startedRunningOn
    ? `${ad.startedRunningOn}T00:00:00.000Z`
    : ad.firstSeenAt;
  return Math.max(0, daysBetween(anchor, nowIso));
}

/**
 * The core reconciliation. Given the freshly scraped ads and the previous
 * snapshot, produce a {@link DiffResult} and the merged snapshot to persist.
 *
 * @param freshAds            Ads from this run's scrape.
 * @param previous            Snapshot loaded from disk.
 * @param winnerThresholdDays Days-running needed to flag a "winner".
 * @param nowIso              Injected "now" (testability / determinism).
 */
export function reconcile(
  freshAds: Ad[],
  previous: Snapshot,
  winnerThresholdDays: number,
  nowIso: string = new Date().toISOString(),
): DiffResult {
  const mergedAds: Record<string, StoredAd> = {};
  const newAds: StoredAd[] = [];
  const longRunningWinners: StoredAd[] = [];
  const stillRunning: StoredAd[] = [];

  // Index fresh ads by id for quick membership checks.
  const freshById = new Map<string, Ad>();
  for (const ad of freshAds) freshById.set(ad.adId, ad);

  /* --- 1) Walk the fresh ads: detect NEW + update EXISTING ------------- */
  for (const ad of freshAds) {
    const prior = previous.ads[ad.adId];

    if (!prior) {
      // Brand-new ad we've never seen before.
      const stored: StoredAd = {
        ...ad,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        seenCount: 1,
        notifiedAsWinner: false,
      };
      mergedAds[ad.adId] = stored;
      newAds.push(stored);
      continue;
    }

    // Existing ad — refresh the volatile fields, keep the history.
    const stored: StoredAd = {
      ...prior,
      // Refresh content in case the creative/text/media changed.
      startedRunningRaw: ad.startedRunningRaw ?? prior.startedRunningRaw,
      startedRunningOn: ad.startedRunningOn ?? prior.startedRunningOn,
      text: ad.text || prior.text,
      media: ad.media.length > 0 ? ad.media : prior.media,
      pageName: ad.pageName ?? prior.pageName,
      adLibraryUrl: ad.adLibraryUrl ?? prior.adLibraryUrl,
      active: ad.active,
      lastSeenAt: nowIso,
      seenCount: prior.seenCount + 1,
    };

    const daysRunning = computeDaysRunning(stored, nowIso);

    if (
      stored.active &&
      daysRunning >= winnerThresholdDays &&
      !stored.notifiedAsWinner
    ) {
      // Newly-qualified evergreen winner. Flag it, mark notified so we don't
      // re-announce it on every subsequent run.
      stored.notifiedAsWinner = true;
      longRunningWinners.push(stored);
    } else {
      stillRunning.push(stored);
    }

    mergedAds[ad.adId] = stored;
  }

  /* --- 2) Carry forward ads that vanished from this run --------------- *
   * They may have simply paused or scrolled past our cap. We keep their
   * history (so they can re-qualify later) but mark them inactive.        */
  for (const [id, prior] of Object.entries(previous.ads)) {
    if (freshById.has(id)) continue;
    mergedAds[id] = {
      ...prior,
      active: false,
    };
  }

  const snapshot: Snapshot = {
    version: SNAPSHOT_VERSION,
    pageId: previous.pageId,
    updatedAt: nowIso,
    ads: mergedAds,
  };

  return { newAds, longRunningWinners, stillRunning, snapshot };
}
