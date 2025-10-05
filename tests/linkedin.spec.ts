import { test, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const START_URL =
  'https://www.linkedin.com/jobs/search?keywords=Ece&location=Greater%20Toronto%20Area%2C%20Canada&geoId=90009551&trk=public_jobs_jobs-search-bar_search-submit&position=1&pageNum=0';

const LINK_SEL =
  'ul.jobs-search__results-list a.base-card__full-link[href*="/jobs/view/"], ' +
  'ul.jobs-search__results-list a[data-tracking-control-name*="jserp-result_search-card"], ' +
  'ul.scaffold-layout__list-container a.base-card__full-link[href*="/jobs/view/"], ' +
  'ul.scaffold-layout__list-container a[data-tracking-control-name*="jserp-result_search-card"]';

const OUT_PATH  = path.resolve('data', 'linkedin.json');
const SHOT_DIR  = path.resolve('test-results', 'pages');
const MAX_PAGES = Number(process.env.PAGES || 3);

type Job = { title: string; employer: string; date?: string; summary?: string; url: string };

test('LinkedIn list → JSON (link-first, list-pane scroll, screenshots, dedupe, next)', async ({ page }) => {
  test.setTimeout(180_000);

  const seen = new Set<string>();
  const all: Job[] = [];

  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);

  for (let p = 0; p < MAX_PAGES; p++) {
    await shot(page, `p${p + 1}-before.png`);

    // soft wait for results container
    await Promise.race([
      page.waitForSelector('ul.jobs-search__results-list', { timeout: 8000 }),
      page.waitForSelector('ul.scaffold-layout__list-container', { timeout: 8000 }),
      page.waitForTimeout(1200),
    ]);

    // scroll the *list pane* (or window fallback) until link count stabilizes
    await fillListByScrolling(page, LINK_SEL);

    // snapshot links on this page
    const links = await page.$$(LINK_SEL);
    if (!links.length) break;
    console.log(`Page ${p + 1}: ${links.length} links`);

    // click + extract per card root (li/article/anchor). no nav waits.
    for (const link of links) {
      const root = (await link.evaluateHandle((el: Element) => (el.closest('li,article') || el))) as any;
      await root.evaluate((el: Element) =>
        (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      ).catch(() => {});
      await page.waitForTimeout(100);

      const item = await extractFrom(root);
      await root.dispose().catch(() => {});
      if (!item?.url) continue;

      item.url = canonicalUrl(item.url);
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      all.push(item);
    }

    // try simple "Next" pagination; stop if it's not visible
    const next = page.locator('button.jobs-search-pagination__indicator[aria-label*="next" i]').first();
    if (!(await next.isVisible().catch(() => false))) break;
    await next.click({ noWaitAfter: true }).catch(() => {});
    await page.waitForTimeout(800);
    await shot(page, `p${p + 1}-after-next.png`);
  }

  await fs.promises.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.promises.writeFile(OUT_PATH, JSON.stringify(all, null, 2), 'utf8');
  console.log(`✅ ${all.length} unique jobs → ${OUT_PATH}`);
});

/* ---------------- helpers (compact) ---------------- */

async function dismissOverlays(page: Page) {
  await page.keyboard.press('Escape').catch(() => {});
  for (const sel of [
    'button:has-text("Accept cookies")',
    'button:has-text("Accept")',
    'button[aria-label="Close"]',
    'button[aria-label="Dismiss"]',
  ]) {
    const b = page.locator(sel).first();
    if (await b.isVisible().catch(() => false)) await b.click({ timeout: 600 }).catch(() => {});
  }
}

// Scroll the results *pane* (nearest scrollable ancestor of the <ul>), with window fallback,
// until the number of job links stops increasing for a few cycles.
async function fillListByScrolling(page: Page, linkSel: string, maxRounds = 24) {
  const list = await page.$('ul.jobs-search__results-list, ul.scaffold-layout__list-container');
  let prev = 0, still = 0;

  for (let i = 0; i < maxRounds; i++) {
    await page.evaluate((ul) => {
      const list = ul as Element | null;
      // find a scrollable ancestor; else fallback to document.scrollingElement
      let pane: Element | null = list?.parentElement || null;
      const scrollable = (e: Element) => {
        const s = getComputedStyle(e as HTMLElement);
        return (/(auto|scroll)/.test(s.overflowY) || /(auto|scroll)/.test(s.overflow)) && e.scrollHeight > e.clientHeight;
      };
      while (pane && pane !== document.body && !scrollable(pane)) pane = pane.parentElement;
      const el: any = pane && scrollable(pane) ? pane : document.scrollingElement || document.body;

      const dy = Math.max(600, (el.clientHeight || window.innerHeight) * 0.9);
      el.scrollBy(0, dy);
    }, list);
    await page.waitForTimeout(250);

    const count = await page.locator(linkSel).count().catch(() => 0);
    if (count <= prev) still++; else { prev = count; still = 0; }
    if (still >= 3) break;
  }
}

function canonicalUrl(input: string) {
  try {
    const u = new URL(input);
    const m = u.pathname.match(/\/jobs\/view\/(\d+)/);
    return m ? `https://www.linkedin.com/jobs/view/${m[1]}` : (u.search = u.hash = '', u.toString());
  } catch { return input; }
}

async function extractFrom(root: any): Promise<Job | null> {
  return root.evaluate((el: Element) => {
    const $ = (s: string, ctx: Element = el) => ctx.querySelector<HTMLElement>(s);
    const t = (s?: string | null) => (s ? s.replace(/\s+/g, ' ').trim() : '');

    const titleEl   = $('.job-title') || $('h3.base-search-card__title') || $('h3');
    const companyEl = $('.company-name') || $('h4.base-search-card__subtitle') || $('h4');
    const descEl    = $('.job-description') || $('.job-search-card__snippet') ||
                      $('div.job-card-container__snippet') || $('p.job-search-card__snippet');
    const timeEl    = $('time');
    const linkEl    = $('a.base-card__full-link[href*="/jobs/view/"]') ||
                      $('a[data-tracking-control-name*="jserp-result_search-card"]') ||
                      $('a[href*="/jobs/view/"]');

    const job = {
      title:   t(titleEl?.textContent),
      employer:t(companyEl?.textContent),
      date:    t(timeEl?.getAttribute('datetime') || timeEl?.textContent) || undefined,
      summary: t(descEl?.textContent) || undefined,
      url:     linkEl ? (linkEl as HTMLAnchorElement).href : '',
    };

    return job.url || job.title || job.employer ? job : null;
  });
}

async function shot(page: Page, name: string) {
  await fs.promises.mkdir(SHOT_DIR, { recursive: true }).catch(() => {});
  await page.screenshot({ path: path.join(SHOT_DIR, name), fullPage: true }).catch(() => {});
}
