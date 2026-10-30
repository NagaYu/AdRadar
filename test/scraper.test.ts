/**
 * scraper.test.ts
 * -------------------------------------------------------------------------
 * Unit tests for the pure, browser-free helpers exported from scraper.ts:
 *   - parseStartedRunning  (Meta date string -> ISO YYYY-MM-DD)
 *   - resolveTargetUrl     (page id | URL -> canonical Ad Library URL)
 *   - normalizeRawAds      (raw DOM extraction -> Ad, incl. permalink)
 *
 * These never launch Chromium, so they run instantly in CI.
 *
 * Run with:  npm test
 * -------------------------------------------------------------------------
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRawAds,
  parseStartedRunning,
  resolveTargetUrl,
  type RawAd,
} from "../src/scraper.js";

/* ---------------------------------------------------------------------- *
 *  parseStartedRunning                                                    *
 * ---------------------------------------------------------------------- */

test("parseStartedRunning: parses abbreviated month form", () => {
  assert.equal(
    parseStartedRunning("Started running on Jan 5, 2024"),
    "2024-01-05",
  );
});

test("parseStartedRunning: parses full month name", () => {
  assert.equal(
    parseStartedRunning("Started running on January 5, 2024"),
    "2024-01-05",
  );
});

test("parseStartedRunning: zero-pads day and month", () => {
  assert.equal(
    parseStartedRunning("Started running on March 9, 2026"),
    "2026-03-09",
  );
});

test("parseStartedRunning: tolerates a trailing middot segment", () => {
  assert.equal(
    parseStartedRunning("Started running on Dec 31, 2025 · Active"),
    "2025-12-31",
  );
});

test("parseStartedRunning: handles the bare date without the lead-in", () => {
  assert.equal(parseStartedRunning("February 28, 2025"), "2025-02-28");
});

test("parseStartedRunning: returns null for null input", () => {
  assert.equal(parseStartedRunning(null), null);
});

test("parseStartedRunning: returns null for unparseable text", () => {
  assert.equal(parseStartedRunning("sometime last spring"), null);
});

/* ---------------------------------------------------------------------- *
 *  resolveTargetUrl                                                       *
 * ---------------------------------------------------------------------- */

test("resolveTargetUrl: passes a full URL through untouched", () => {
  const url =
    "https://www.facebook.com/ads/library/?active_status=active&view_all_page_id=999";
  assert.equal(resolveTargetUrl(url, "US"), url);
});

test("resolveTargetUrl: builds a canonical URL from a bare page id", () => {
  const result = resolveTargetUrl("123456789", "US");
  const parsed = new URL(result);

  assert.equal(parsed.origin + parsed.pathname, "https://www.facebook.com/ads/library/");
  assert.equal(parsed.searchParams.get("view_all_page_id"), "123456789");
  assert.equal(parsed.searchParams.get("country"), "US");
  assert.equal(parsed.searchParams.get("active_status"), "active");
  assert.equal(parsed.searchParams.get("search_type"), "page");
});

test("resolveTargetUrl: respects the requested country filter", () => {
  const result = resolveTargetUrl("123456789", "ALL");
  assert.equal(new URL(result).searchParams.get("country"), "ALL");
});

test("resolveTargetUrl: trims surrounding whitespace from the page id", () => {
  const result = resolveTargetUrl("  42  ", "US");
  assert.equal(new URL(result).searchParams.get("view_all_page_id"), "42");
});

/* ---------------------------------------------------------------------- *
 *  normalizeRawAds                                                        *
 * ---------------------------------------------------------------------- */

function rawAd(overrides: Partial<RawAd> = {}): RawAd {
  return {
    adId: "1234567890123456",
    startedRunningRaw: "Started running on Jan 5, 2024",
    text: "Just do it.",
    media: [{ type: "image", url: "https://scontent.example/creative.jpg" }],
    pageName: "Nike",
    adLibraryUrl: null,
    active: true,
    ...overrides,
  };
}

test("normalizeRawAds: builds the permalink from a numeric Library ID", () => {
  const [ad] = normalizeRawAds([rawAd()]);
  assert.equal(
    ad!.adLibraryUrl,
    "https://www.facebook.com/ads/library/?id=1234567890123456",
  );
});

test("normalizeRawAds: prefers a permalink found in the DOM", () => {
  const url = "https://www.facebook.com/ads/library/?id=999999999";
  const [ad] = normalizeRawAds([rawAd({ adLibraryUrl: url })]);
  assert.equal(ad!.adLibraryUrl, url);
});

test("normalizeRawAds: leaves the permalink null for a synthetic id", () => {
  const [ad] = normalizeRawAds([rawAd({ adId: null })]);
  assert.match(ad!.adId, /^synthetic-/);
  assert.equal(ad!.adLibraryUrl, null);
});

test("normalizeRawAds: trims the Library ID before building the permalink", () => {
  const [ad] = normalizeRawAds([rawAd({ adId: " 1234567890123456 " })]);
  assert.equal(ad!.adId, "1234567890123456");
  assert.equal(
    ad!.adLibraryUrl,
    "https://www.facebook.com/ads/library/?id=1234567890123456",
  );
});

test("normalizeRawAds: parses the start date", () => {
  const [ad] = normalizeRawAds([rawAd()]);
  assert.equal(ad!.startedRunningOn, "2024-01-05");
});
