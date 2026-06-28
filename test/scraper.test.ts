/**
 * scraper.test.ts
 * -------------------------------------------------------------------------
 * Unit tests for the pure, browser-free helpers exported from scraper.ts:
 *   - parseStartedRunning  (Meta date string -> ISO YYYY-MM-DD)
 *   - resolveTargetUrl     (page id | URL -> canonical Ad Library URL)
 *
 * These never launch Chromium, so they run instantly in CI.
 *
 * Run with:  npm test
 * -------------------------------------------------------------------------
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStartedRunning, resolveTargetUrl } from "../src/scraper.js";

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
