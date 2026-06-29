/**
 * scraper.ts
 * -------------------------------------------------------------------------
 * The heart of AdRadar: a resilient Playwright crawler for the Meta
 * (Facebook) Ad Library.
 *
 * The Ad Library is a heavily client-rendered React application. There is no
 * clean public JSON endpoint we can rely on long-term, so we drive a real
 * Chromium instance, defeat the cookie wall, run a bounded infinite-scroll
 * loop, and extract structured data out of the very obfuscated DOM.
 *
 * Design notes
 * ------------
 *  - We DO NOT depend on Meta's hashed CSS class names (they rotate). Instead
 *    we anchor on stable, human-readable text anchors ("Library ID:",
 *    "Started running on", "Active") and on durable attributes
 *    (role, aria-label, href patterns, media tag names).
 *  - All extraction runs inside `page.evaluate` so we touch the live DOM only
 *    once per scroll settle, which is both faster and less detectable than
 *    chatty per-element round trips.
 *  - Every selector lookup is defensive: missing nodes degrade to null rather
 *    than throwing, because the Ad Library is wildly inconsistent card-to-card.
 * -------------------------------------------------------------------------
 */

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { createHash } from "node:crypto";
import { cyan, dim, yellow } from "colorette";
import type { Ad, CreativeMedia, RuntimeConfig } from "./types.js";

/**
 * A pool of realistic, modern desktop User-Agent strings. We pick one per run
 * to avoid presenting a single static fingerprint across many invocations.
 */
const USER_AGENTS: readonly string[] = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
];

/**
 * Deterministically pick a UA based on the page id so a given competitor is
 * always crawled with a consistent fingerprint within a session, while
 * different targets spread across the pool.
 */
function pickUserAgent(seed: string): string {
  const hash = createHash("md5").update(seed).digest();
  const index = hash[0]! % USER_AGENTS.length;
  return USER_AGENTS[index]!;
}

/**
 * Build the canonical Ad Library URL from either a bare page id or a full URL
 * that the user pasted in directly.
 */
export function resolveTargetUrl(pageIdOrUrl: string, country: string): string {
  const trimmed = pageIdOrUrl.trim();

  // The user gave us a full URL already — respect it verbatim.
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  // Otherwise assemble the standard "all ads for this page" view.
  const params = new URLSearchParams({
    active_status: "active",
    ad_type: "all",
    country: country,
    is_targeted_country: "false",
    media_type: "all",
    search_type: "page",
    view_all_page_id: trimmed,
  });

  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

/**
 * Best-effort parser for Meta's "Started running on Jan 5, 2024" strings into
 * an ISO YYYY-MM-DD date. Handles the common English formats the Ad Library
 * emits. Returns null when it genuinely cannot tell.
 */
export function parseStartedRunning(raw: string | null): string | null {
  if (!raw) return null;

  // Strip the lead-in so we are left with just the date portion.
  const cleaned = raw
    .replace(/started\s+running\s+on/i, "")
    .replace(/·.*/, "")
    .trim();

  // Primary path: explicit "Mon D, YYYY" regex anchored to UTC. We do this
  // FIRST (before the native Date parser) because `new Date("Jan 5, 2024")`
  // resolves to *local* midnight, and reading it back via UTC getters shifts
  // the calendar day in any non-UTC timezone. Building from components with
  // Date.UTC makes the result deterministic regardless of the host timezone.
  const match = cleaned.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
  if (match) {
    const [, monthName, day, year] = match;
    const monthIndex = MONTHS.findIndex((m) =>
      m.toLowerCase().startsWith(monthName!.toLowerCase().slice(0, 3)),
    );
    if (monthIndex >= 0) {
      const d = new Date(Date.UTC(Number(year), monthIndex, Number(day)));
      if (!Number.isNaN(d.getTime())) return toIsoDate(d);
    }
  }

  // Fallback: hand the whole string to the native parser for unusual formats
  // (e.g. "2024-01-05", "5 January 2024"). It yields a local-time Date, so we
  // read it back with LOCAL getters to stay consistent with how it parsed.
  const native = new Date(cleaned);
  if (!Number.isNaN(native.getTime())) {
    return toLocalIsoDate(native);
  }

  return null;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Format a UTC-anchored Date as YYYY-MM-DD using its UTC components. */
function toIsoDate(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Format a local-time Date as YYYY-MM-DD using its local components. */
function toLocalIsoDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Synthesize a deterministic id from an ad's content. Used only when Meta does
 * not give us a real Library ID, so that diffing remains stable across runs.
 */
function synthesizeId(text: string, mediaUrl: string | undefined): string {
  return (
    "synthetic-" +
    createHash("sha1")
      .update(text.slice(0, 512))
      .update("::")
      .update(mediaUrl ?? "no-media")
      .digest("hex")
      .slice(0, 16)
  );
}

/**
 * Public progress callback so the CLI can render nice spinners/lines without
 * the scraper importing the CLI layer.
 */
export type ProgressFn = (message: string) => void;

/**
 * Launch Chromium with anti-detection hardening, navigate to the target Ad
 * Library page, exhaust the infinite scroll, and return normalized ads.
 */
export async function scrapeAdLibrary(
  config: RuntimeConfig,
  onProgress: ProgressFn = () => {},
): Promise<Ad[]> {
  const userAgent = pickUserAgent(config.pageId);

  onProgress(dim(`Launching Chromium (headless=${config.headless})`));

  const browser: Browser = await chromium.launch({
    headless: config.headless,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-setuid-sandbox",
      "--window-size=1440,2400",
    ],
  });

  let context: BrowserContext | null = null;

  try {
    context = await browser.newContext({
      userAgent,
      locale: "en-US",
      timezoneId: "America/New_York",
      viewport: { width: 1440, height: 2400 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      javaScriptEnabled: true,
      bypassCSP: true,
      // Only set Accept-Language. We deliberately DO NOT hand-spoof the
      // Sec-Ch-Ua* client hints or Upgrade-Insecure-Requests: Chromium already
      // emits accurate values for those, and overriding them with static
      // strings creates an inconsistent fingerprint that Meta blocks on
      // (verified: the manual client-hint headers cause the Ad Library to
      // return a blank, result-less page).
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    // Strip the most obvious automation tells before any page script runs.
    await context.addInitScript(() => {
      // navigator.webdriver -> undefined
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });

      // A believable plugins array.
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });

      // Languages.
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      });

      // Pretend we have a normal amount of hardware.
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
      Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });

      // Spoof the WebGL vendor/renderer fingerprint.
      try {
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        WebGLRenderingContext.prototype.getParameter = function (this: any, parameter: number) {
          if (parameter === 37445) return "Intel Inc.";
          if (parameter === 37446) return "Intel Iris OpenGL Engine";
          // eslint-disable-next-line prefer-rest-params
          return getParameter.apply(this, arguments as unknown as [number]);
        };
      } catch {
        /* WebGL not available in this context — ignore. */
      }

      // window.chrome shim so headless looks like real Chrome.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).chrome = { runtime: {} };
    });

    const page: Page = await context.newPage();
    page.setDefaultTimeout(config.navigationTimeoutMs);
    page.setDefaultNavigationTimeout(config.navigationTimeoutMs);

    onProgress(cyan(`Navigating to ${config.targetUrl}`));
    await page.goto(config.targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: config.navigationTimeoutMs,
    });

    await dismissCookieBanner(page, onProgress);

    // Give the SPA a beat to mount its first batch of results.
    await page.waitForTimeout(2500);
    await waitForFirstResults(page, onProgress);

    await infiniteScroll(page, config, onProgress);

    onProgress(dim("Extracting ad cards from the DOM"));
    const rawAds = await extractAds(page);

    // Normalize / enrich on the Node side (parsing dates, synthesizing ids).
    const ads: Ad[] = rawAds.map((raw) => {
      const startedRunningOn = parseStartedRunning(raw.startedRunningRaw);
      const adId =
        raw.adId && raw.adId.trim().length > 0
          ? raw.adId.trim()
          : synthesizeId(raw.text, raw.media[0]?.url);

      return {
        adId,
        startedRunningRaw: raw.startedRunningRaw,
        startedRunningOn,
        text: raw.text,
        media: raw.media,
        pageName: raw.pageName,
        adLibraryUrl: raw.adLibraryUrl,
        active: raw.active,
      };
    });

    // De-duplicate by adId — the same card can appear twice mid-virtualization.
    const deduped = new Map<string, Ad>();
    for (const ad of ads) {
      if (!deduped.has(ad.adId)) deduped.set(ad.adId, ad);
    }

    onProgress(cyan(`Extracted ${deduped.size} unique ad(s)`));
    return [...deduped.values()];
  } finally {
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * Meta throws a GDPR/cookie consent wall in front of EU-ish visitors. We try a
 * battery of localized button labels and known data-testids. Failure here is
 * non-fatal — we just continue.
 */
async function dismissCookieBanner(page: Page, onProgress: ProgressFn): Promise<void> {
  const candidates: Array<{ kind: "role" | "testid"; value: string }> = [
    { kind: "testid", value: "cookie-policy-manage-dialog-accept-button" },
    { kind: "role", value: "Allow all cookies" },
    { kind: "role", value: "Accept all" },
    { kind: "role", value: "Allow essential and optional cookies" },
    { kind: "role", value: "Only allow essential cookies" },
    { kind: "role", value: "Decline optional cookies" },
    { kind: "role", value: "Accept All" },
  ];

  for (const candidate of candidates) {
    try {
      const locator =
        candidate.kind === "testid"
          ? page.locator(`[data-testid="${candidate.value}"]`)
          : page.getByRole("button", { name: candidate.value, exact: false });

      if (await locator.first().isVisible({ timeout: 1500 }).catch(() => false)) {
        await locator.first().click({ timeout: 2500 }).catch(() => {});
        onProgress(dim(`Dismissed cookie banner via "${candidate.value}"`));
        await page.waitForTimeout(800);
        return;
      }
    } catch {
      /* Try the next candidate. */
    }
  }

  onProgress(dim("No cookie banner detected (or already dismissed)"));
}

/**
 * Wait until at least one result-ish container is present. We anchor on the
 * "Library ID" text which every real ad card carries, falling back to the
 * "results" heading. Non-fatal on timeout (page may legitimately have 0 ads).
 */
async function waitForFirstResults(page: Page, onProgress: ProgressFn): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        const body = document.body?.innerText ?? "";
        if (/library id/i.test(body)) return true;
        if (/~?\s*\d[\d,]*\s+results/i.test(body)) return true;
        // "It looks like we don't have any ads..." empty-state is also "ready".
        if (/don'?t have any ads/i.test(body)) return true;
        return false;
      },
      undefined,
      { timeout: 20000 },
    );
    onProgress(dim("First results rendered"));
  } catch {
    onProgress(yellow("Timed out waiting for first results — continuing anyway"));
  }
}

/**
 * The bounded infinite-scroll loop. We repeatedly scroll to the bottom, wait
 * for the network/DOM to settle, and stop when either:
 *   - the scroll height stops growing for two consecutive passes, or
 *   - we hit `config.maxScrolls`.
 */
async function infiniteScroll(
  page: Page,
  config: RuntimeConfig,
  onProgress: ProgressFn,
): Promise<void> {
  let previousHeight = 0;
  let stagnantPasses = 0;
  let pass = 0;

  while (pass < config.maxScrolls) {
    pass += 1;

    const currentHeight: number = await page.evaluate(
      () => document.body.scrollHeight,
    );

    // Scroll in two steps so lazy IntersectionObservers reliably fire.
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight * 0.5);
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });

    // Wait for the network to go quiet, but never hang forever.
    await page
      .waitForLoadState("networkidle", { timeout: 8000 })
      .catch(() => {});
    await page.waitForTimeout(1200 + Math.floor(Math.random() * 600));

    const newHeight: number = await page.evaluate(
      () => document.body.scrollHeight,
    );

    const approxCards: number = await page.evaluate(() => {
      const text = document.body.innerText || "";
      const matches = text.match(/library id/gi);
      return matches ? matches.length : 0;
    });

    onProgress(
      dim(
        `Scroll pass ${pass}/${config.maxScrolls} — height ${currentHeight} -> ${newHeight}, ~${approxCards} cards`,
      ),
    );

    if (newHeight <= previousHeight && newHeight <= currentHeight) {
      stagnantPasses += 1;
      if (stagnantPasses >= 2) {
        onProgress(dim("Reached the end of the feed — stopping scroll"));
        break;
      }
    } else {
      stagnantPasses = 0;
    }

    previousHeight = Math.max(previousHeight, newHeight);
  }

  if (pass >= config.maxScrolls) {
    onProgress(
      yellow(`Hit max scroll cap (${config.maxScrolls}) — there may be more ads`),
    );
  }

  // Scroll back to the top so the eventual extraction sees a settled layout.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
}

/**
 * The shape returned from inside `page.evaluate`. It mirrors {@link Ad} but
 * without the Node-side enrichments (parsed date / synthesized id), because
 * those are easier and safer to compute outside the browser sandbox.
 */
interface RawAd {
  adId: string | null;
  startedRunningRaw: string | null;
  text: string;
  media: CreativeMedia[];
  pageName: string | null;
  adLibraryUrl: string | null;
  active: boolean;
}

/**
 * Run the heavy DOM extraction entirely inside the page. We must keep this
 * function self-contained: no closures over Node-side variables, no imports.
 */
async function extractAds(page: Page): Promise<RawAd[]> {
  return page.evaluate(() => {
    /* ---------------------------------------------------------------- *
     * In-page helpers (duplicated here because evaluate is sandboxed).  *
     * ---------------------------------------------------------------- */

    const visibleText = (el: Element | null): string => {
      if (!el) return "";
      const text = (el as HTMLElement).innerText ?? el.textContent ?? "";
      return text.replace(/ /g, " ").trim();
    };

    /**
     * Walk upward from a text anchor to the single ad card that owns it.
     *
     * The card boundary is the HIGHEST ancestor whose subtree still contains
     * exactly one "Library ID" — one hop higher and the node balloons out to
     * the shared results container (which holds every card).
     *
     * NOTE: we deliberately do NOT gate on element height. The Ad Library
     * virtualizes its feed, so off-screen cards report a bounding height of 0;
     * an earlier height filter caused every card except the one in the
     * viewport to be dropped. Counting Library IDs is layout-independent and
     * works for on- and off-screen cards alike.
     */
    const findCardRoot = (anchor: Element): Element | null => {
      let node: Element | null = anchor;
      let chosen: Element | null = null;
      let hops = 0;
      while (node && hops < 16) {
        const txt = (node as HTMLElement).innerText ?? "";
        const idCount = (txt.match(/library id/gi) || []).length;
        if (idCount === 1) {
          // Still scoped to a single card — remember this as the best root.
          chosen = node;
        } else if (idCount > 1) {
          // One hop too far: we've reached the shared results container.
          break;
        }
        node = node.parentElement;
        hops += 1;
      }
      return chosen;
    };

    const classifyMedia = (url: string): "image" | "video" | "unknown" => {
      const u = url.toLowerCase();
      if (/\.(mp4|webm|m3u8|mov)(\?|$)/.test(u) || u.includes("video")) {
        return "video";
      }
      if (/\.(jpg|jpeg|png|gif|webp)(\?|$)/.test(u) || u.includes("scontent")) {
        return "image";
      }
      return "unknown";
    };

    /* ---------------------------------------------------------------- *
     * Discover the set of unique card roots via the Library ID anchor. *
     * ---------------------------------------------------------------- */

    const anchors: Element[] = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null,
    );
    let textNode: Node | null = walker.nextNode();
    while (textNode) {
      const content = textNode.textContent ?? "";
      if (/library id/i.test(content)) {
        if (textNode.parentElement) anchors.push(textNode.parentElement);
      }
      textNode = walker.nextNode();
    }

    const seenRoots = new Set<Element>();
    const cards: Element[] = [];
    for (const anchor of anchors) {
      const root = findCardRoot(anchor);
      if (root && !seenRoots.has(root)) {
        seenRoots.add(root);
        cards.push(root);
      }
    }

    /* ---------------------------------------------------------------- *
     * Extract one RawAd per card.                                      *
     * ---------------------------------------------------------------- */

    const results: Array<{
      adId: string | null;
      startedRunningRaw: string | null;
      text: string;
      media: Array<{ type: "image" | "video" | "unknown"; url: string; thumbnailUrl?: string }>;
      pageName: string | null;
      adLibraryUrl: string | null;
      active: boolean;
    }> = [];

    for (const card of cards) {
      const cardText = visibleText(card);

      /* --- Library / Ad ID --------------------------------------- */
      let adId: string | null = null;
      const idMatch = cardText.match(/library id[:\s]*([0-9]{6,})/i);
      if (idMatch) adId = idMatch[1] ?? null;

      /* --- Started running on ------------------------------------ */
      let startedRunningRaw: string | null = null;
      const startedMatch = cardText.match(
        /started running on[^\n]*?([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i,
      );
      if (startedMatch) {
        startedRunningRaw = `Started running on ${startedMatch[1]}`;
      } else {
        const loose = cardText.match(/started running on[^\n]{0,40}/i);
        if (loose) startedRunningRaw = loose[0]!.trim();
      }

      /* --- Active status ----------------------------------------- */
      const active = /\bactive\b/i.test(cardText) && !/\binactive\b/i.test(cardText);

      /* --- Ad permalink ------------------------------------------ */
      let adLibraryUrl: string | null = null;
      const links = Array.from(card.querySelectorAll("a[href]")) as HTMLAnchorElement[];
      for (const link of links) {
        const href = link.href || "";
        if (/\/ads\/library\/\?id=/.test(href) || /[?&]id=\d{6,}/.test(href)) {
          adLibraryUrl = href;
          if (!adId) {
            const m = href.match(/[?&]id=(\d{6,})/);
            if (m) adId = m[1] ?? null;
          }
          break;
        }
      }

      /* --- Page / advertiser name -------------------------------- */
      let pageName: string | null = null;
      // The advertiser name usually sits in the first strong/bold-ish link.
      for (const link of links) {
        const t = visibleText(link);
        if (
          t &&
          t.length > 1 &&
          t.length < 80 &&
          !/sponsored|see ad details|library id|open dropdown/i.test(t) &&
          !/^https?:/i.test(t)
        ) {
          pageName = t;
          break;
        }
      }

      /* --- Primary body copy ------------------------------------- */
      // Strategy: collect candidate text blocks, drop boilerplate, keep the
      // longest remaining human-readable paragraph.
      const boilerplate =
        /(library id|sponsored|started running on|active|inactive|platforms|see ad details|see summary details|open dropdown|this ad has multiple versions|why am i seeing this)/i;

      const blocks: string[] = [];
      const divs = Array.from(card.querySelectorAll("div, span")) as HTMLElement[];
      for (const div of divs) {
        // Only consider leaf-ish nodes to avoid grabbing the whole card text.
        const childElementCount = div.childElementCount;
        const t = visibleText(div);
        if (!t) continue;
        if (childElementCount > 3) continue;
        if (t.length < 15) continue;
        if (boilerplate.test(t)) continue;
        blocks.push(t);
      }
      // Deduplicate and pick the longest distinct block as the main copy.
      const uniqueBlocks = Array.from(new Set(blocks)).sort(
        (a, b) => b.length - a.length,
      );
      let text = uniqueBlocks[0] ?? "";
      // Guard against accidentally capturing the entire card.
      if (text.length > 2000) text = text.slice(0, 2000) + "…";

      /* --- Media (images + videos) ------------------------------- */
      const media: Array<{
        type: "image" | "video" | "unknown";
        url: string;
        thumbnailUrl?: string;
      }> = [];
      const mediaSeen = new Set<string>();

      // Videos first (so their poster frames are preferred as thumbnails).
      const videos = Array.from(card.querySelectorAll("video")) as HTMLVideoElement[];
      for (const video of videos) {
        const src =
          video.currentSrc ||
          video.src ||
          (video.querySelector("source") as HTMLSourceElement | null)?.src ||
          "";
        const poster = video.poster || undefined;
        if (src && !mediaSeen.has(src)) {
          mediaSeen.add(src);
          media.push({ type: "video", url: src, thumbnailUrl: poster });
        } else if (!src && poster && !mediaSeen.has(poster)) {
          // Video element with only a poster (lazy-loaded) — still useful.
          mediaSeen.add(poster);
          media.push({ type: "video", url: poster, thumbnailUrl: poster });
        }
      }

      // Then images. Skip tiny icons / profile chrome by dimension + URL.
      const imgs = Array.from(card.querySelectorAll("img")) as HTMLImageElement[];
      for (const img of imgs) {
        const src = img.currentSrc || img.src || "";
        if (!src || mediaSeen.has(src)) continue;
        if (src.startsWith("data:")) continue;
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        // Profile pics / emoji / spinners tend to be small & square.
        const looksLikeChrome =
          (w > 0 && w < 60 && h > 0 && h < 60) ||
          /emoji|static\.xx\.fbcdn\.net\/rsrc/i.test(src) ||
          /s60x60|p60x60|p32x32/i.test(src);
        if (looksLikeChrome) continue;
        mediaSeen.add(src);
        media.push({ type: classifyMedia(src), url: src });
      }

      results.push({
        adId,
        startedRunningRaw,
        text,
        media,
        pageName,
        adLibraryUrl,
        active,
      });
    }

    return results;
  });
}
