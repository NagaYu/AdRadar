/**
 * storage.test.ts
 * -------------------------------------------------------------------------
 * Unit tests for the pure reconciliation / date-math core in storage.ts.
 *
 * These functions are where the product's value lives (new vs. winner
 * detection), and they are fully deterministic — we inject "now" everywhere —
 * so they're cheap to lock down with tests. No browser, no network.
 *
 * Run with:  npm test
 * -------------------------------------------------------------------------
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  daysBetween,
  computeDaysRunning,
  reconcile,
} from "../src/storage.js";
import type { Ad, Snapshot, StoredAd } from "../src/types.js";

/* ---------------------------------------------------------------------- *
 *  Fixtures                                                               *
 * ---------------------------------------------------------------------- */

const NOW = "2026-06-28T12:00:00.000Z";

function makeAd(overrides: Partial<Ad> = {}): Ad {
  return {
    adId: "ad-1",
    startedRunningRaw: "Started running on Jun 1, 2026",
    startedRunningOn: "2026-06-01",
    text: "Buy our thing",
    media: [{ type: "image", url: "https://cdn.example/creative.jpg" }],
    pageName: "Acme",
    adLibraryUrl: "https://www.facebook.com/ads/library/?id=ad-1",
    active: true,
    ...overrides,
  };
}

function makeStoredAd(overrides: Partial<StoredAd> = {}): StoredAd {
  return {
    ...makeAd(),
    firstSeenAt: "2026-06-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    seenCount: 1,
    notifiedAsWinner: false,
    ...overrides,
  };
}

function emptySnapshot(pageId = "page-123"): Snapshot {
  return {
    version: 1,
    pageId,
    updatedAt: "1970-01-01T00:00:00.000Z",
    ads: {},
  };
}

/* ---------------------------------------------------------------------- *
 *  daysBetween                                                            *
 * ---------------------------------------------------------------------- */

test("daysBetween: counts whole days forward", () => {
  assert.equal(
    daysBetween("2026-06-01T00:00:00.000Z", "2026-06-08T00:00:00.000Z"),
    7,
  );
});

test("daysBetween: floors partial days", () => {
  assert.equal(
    daysBetween("2026-06-01T00:00:00.000Z", "2026-06-08T11:59:00.000Z"),
    7,
  );
});

test("daysBetween: returns 0 for invalid input", () => {
  assert.equal(daysBetween("not-a-date", NOW), 0);
});

/* ---------------------------------------------------------------------- *
 *  computeDaysRunning                                                     *
 * ---------------------------------------------------------------------- */

test("computeDaysRunning: prefers Meta's startedRunningOn date", () => {
  const ad = makeStoredAd({
    startedRunningOn: "2026-06-21", // 7 days before NOW
    firstSeenAt: "2026-06-27T00:00:00.000Z", // only 1 day — must be ignored
  });
  assert.equal(computeDaysRunning(ad, NOW), 7);
});

test("computeDaysRunning: falls back to firstSeenAt when no parsed date", () => {
  const ad = makeStoredAd({
    startedRunningOn: null,
    firstSeenAt: "2026-06-18T12:00:00.000Z", // 10 days before NOW
  });
  assert.equal(computeDaysRunning(ad, NOW), 10);
});

test("computeDaysRunning: never goes negative for future start dates", () => {
  const ad = makeStoredAd({ startedRunningOn: "2026-12-31" });
  assert.equal(computeDaysRunning(ad, NOW), 0);
});

/* ---------------------------------------------------------------------- *
 *  reconcile — NEW detection                                             *
 * ---------------------------------------------------------------------- */

test("reconcile: an unseen ad is reported as new and stamped", () => {
  const fresh = [makeAd({ adId: "brand-new" })];
  const diff = reconcile(fresh, emptySnapshot(), 7, NOW);

  assert.equal(diff.newAds.length, 1);
  assert.equal(diff.longRunningWinners.length, 0);

  const stored = diff.newAds[0]!;
  assert.equal(stored.adId, "brand-new");
  assert.equal(stored.firstSeenAt, NOW);
  assert.equal(stored.lastSeenAt, NOW);
  assert.equal(stored.seenCount, 1);
  assert.equal(stored.notifiedAsWinner, false);
  assert.ok(diff.snapshot.ads["brand-new"], "new ad is persisted");
});

/* ---------------------------------------------------------------------- *
 *  reconcile — WINNER detection                                          *
 * ---------------------------------------------------------------------- */

test("reconcile: an old active ad crossing the threshold becomes a winner once", () => {
  const previous = emptySnapshot();
  previous.ads["evergreen"] = makeStoredAd({
    adId: "evergreen",
    startedRunningOn: "2026-06-01", // 27 days before NOW, well past 7
    notifiedAsWinner: false,
    seenCount: 5,
  });

  const fresh = [makeAd({ adId: "evergreen", active: true })];
  const diff = reconcile(fresh, previous, 7, NOW);

  assert.equal(diff.longRunningWinners.length, 1, "fires winner");
  assert.equal(diff.newAds.length, 0);
  assert.equal(diff.longRunningWinners[0]!.notifiedAsWinner, true);
  assert.equal(diff.longRunningWinners[0]!.seenCount, 6, "seenCount incremented");
});

test("reconcile: a winner already announced is not re-announced", () => {
  const previous = emptySnapshot();
  previous.ads["evergreen"] = makeStoredAd({
    adId: "evergreen",
    startedRunningOn: "2026-06-01",
    notifiedAsWinner: true, // already told the user
  });

  const fresh = [makeAd({ adId: "evergreen", active: true })];
  const diff = reconcile(fresh, previous, 7, NOW);

  assert.equal(diff.longRunningWinners.length, 0, "no duplicate winner ping");
  assert.equal(diff.stillRunning.length, 1);
});

test("reconcile: a young ad below the threshold is not a winner", () => {
  const previous = emptySnapshot();
  previous.ads["fresh"] = makeStoredAd({
    adId: "fresh",
    startedRunningOn: "2026-06-25", // only 3 days before NOW
  });

  // The fresh scrape must also carry the young date — reconcile (correctly)
  // refreshes the start date from the latest scrape, so a stale default here
  // would override the prior young date and wrongly trip the winner rule.
  const fresh = [makeAd({ adId: "fresh", active: true, startedRunningOn: "2026-06-25" })];
  const diff = reconcile(fresh, previous, 7, NOW);

  assert.equal(diff.longRunningWinners.length, 0);
  assert.equal(diff.stillRunning.length, 1);
});

test("reconcile: an old but INACTIVE ad does not qualify as a winner", () => {
  const previous = emptySnapshot();
  previous.ads["paused"] = makeStoredAd({
    adId: "paused",
    startedRunningOn: "2026-06-01",
  });

  const fresh = [makeAd({ adId: "paused", active: false })];
  const diff = reconcile(fresh, previous, 7, NOW);

  assert.equal(diff.longRunningWinners.length, 0);
});

/* ---------------------------------------------------------------------- *
 *  reconcile — bookkeeping                                               *
 * ---------------------------------------------------------------------- */

test("reconcile: content fields refresh while history is preserved", () => {
  const previous = emptySnapshot();
  previous.ads["ad-1"] = makeStoredAd({
    adId: "ad-1",
    text: "OLD COPY",
    firstSeenAt: "2026-06-10T00:00:00.000Z",
    seenCount: 3,
  });

  const fresh = [
    makeAd({ adId: "ad-1", text: "NEW COPY", active: true, startedRunningOn: "2026-06-26" }),
  ];
  const diff = reconcile(fresh, previous, 7, NOW);

  const stored = diff.snapshot.ads["ad-1"]!;
  assert.equal(stored.text, "NEW COPY", "copy refreshed");
  assert.equal(stored.firstSeenAt, "2026-06-10T00:00:00.000Z", "firstSeen preserved");
  assert.equal(stored.lastSeenAt, NOW, "lastSeen updated");
  assert.equal(stored.seenCount, 4, "seenCount incremented");
});

test("reconcile: ads missing from this run are carried forward as inactive", () => {
  const previous = emptySnapshot();
  previous.ads["vanished"] = makeStoredAd({ adId: "vanished", active: true });

  const diff = reconcile([], previous, 7, NOW);

  assert.equal(diff.newAds.length, 0);
  const carried = diff.snapshot.ads["vanished"]!;
  assert.ok(carried, "ad is retained, not dropped");
  assert.equal(carried.active, false, "marked inactive");
});

test("reconcile: snapshot metadata is stamped with the injected now", () => {
  const diff = reconcile([makeAd()], emptySnapshot("page-xyz"), 7, NOW);
  assert.equal(diff.snapshot.updatedAt, NOW);
  assert.equal(diff.snapshot.pageId, "page-xyz");
  assert.equal(diff.snapshot.version, 1);
});
