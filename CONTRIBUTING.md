# Contributing to AdRadar

Thanks for your interest in improving AdRadar! 📡

AdRadar is an **experimental** competitive-intelligence tool that scrapes the public Meta (Facebook) Ad Library. Because it depends on a third-party site that changes frequently, the single most valuable kind of contribution is **keeping the scraper working against Meta's evolving DOM**.

## Ways to contribute

- 🩹 **Fix broken selectors.** When Meta changes its markup and AdRadar starts returning 0 ads (or garbage), a PR that updates the anchors/regexes in [`src/scraper.ts`](src/scraper.ts) is gold.
- ✨ **New features** from the [roadmap](README.md#-roadmap) (Telegram/Teams transports, CSV export, creative diffing, etc.).
- 🧪 **More tests** around the pure logic (`src/storage.ts`, the date/URL helpers in `src/scraper.ts`).
- 📖 **Docs** improvements.

## Development setup

```bash
git clone https://github.com/NagaYu/AdRadar.git
cd AdRadar
npm install                      # installs deps + Chromium (via postinstall)
npm run build                    # bundle the CLI to dist/
```

If you skipped the browser download, install it explicitly:

```bash
npx playwright install chromium
```

## The checks your PR must pass

CI runs these on Node 18, 20, and 22. Run them locally first:

```bash
npm run typecheck    # strict TypeScript, no errors
npm test             # 25+ unit tests
npm run build        # the bundle must compile
```

All three must be green. CI will block a merge otherwise.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/types.ts` | Shared strict types |
| `src/scraper.ts` | Playwright crawler + DOM extraction (the brittle part) |
| `src/storage.ts` | Snapshot load/save + new/winner reconciliation (pure, tested) |
| `src/notifier.ts` | Slack/Discord payload building + delivery |
| `src/index.ts` | CLI wiring + progress UI |
| `test/` | Unit tests (`node --test` via `tsx`) |

## Guidelines

- **Keep the scraper resilient.** Prefer anchoring on durable, human-readable text (`"Library ID"`, `"Started running on"`) and stable attributes over Meta's hashed CSS class names, which rotate constantly.
- **Keep pure logic pure.** The reconciliation in `storage.ts` injects "now" so it stays deterministic and testable — please preserve that.
- **Add a test** for any bug you fix in the pure layer, so it can't regress.
- **Match the existing style.** Strict types, descriptive comments on the non-obvious bits, no `any` unless truly unavoidable.
- **Be a good web citizen.** Don't add aggressive scraping behavior (tight loops, parallel hammering). See the README's *Legal & responsible use* section.

## Commit & PR

- Use clear, conventional-ish commit messages (`fix(scraper): ...`, `feat: ...`, `docs: ...`).
- Describe **what** changed and **why** in the PR. If you fixed a selector, a note on what Meta changed helps the next maintainer.
- One logical change per PR where practical.

## Reporting bugs

Open an issue using the **Bug report** template. For scraper breakage, please include:

- The exact command you ran
- Whether `--no-headless` shows ads rendering in the browser
- The country/region you're running from (region gating is real)
- Node version and OS

## License

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
