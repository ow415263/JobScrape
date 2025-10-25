import { test } from '@playwright/test';
import { chromium, Page } from 'patchright';
import fs from 'fs';
import path from 'path';

const TARGET_URL =
  'https://www.jobbank.gc.ca/jobsearch/jobsearch?fn21=42202&page=1&sort=M&fprov=ON';

const SHOTS_DIR = path.resolve('screens');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const OUT_PATH = path.resolve('data', 'bank.json');

type Job = {
  title: string;
  employer: string;
  location?: string;
  date?: string;
  salary?: string;
  url: string;
};

// ---- helpers ----
async function acceptConsent(page: Page): Promise<void> {
  const btn = page
    .locator(
      [
        '#onetrust-accept-btn-handler',
        'button:has-text("Accept all")',
        'button:has-text("Accept All")',
        'button:has-text("I agree")',
        'button:has-text("Got it")',
      ].join(', ')
    )
    .first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click().catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function looksLikeGate(page: Page): Promise<boolean> {
  const texts = [
    /captcha/i,
    /verify you/i,
    /are you a robot/i,
    /unusual traffic/i,
    /access denied/i,
    /additional verification required/i,
  ];
  for (const t of texts) {
    if (await page.getByText(t).first().isVisible().catch(() => false)) return true;
  }
  const recaptcha = await page
    .locator('iframe[title*="challenge"], iframe[title*="captcha"], iframe[src*="recaptcha"]')
    .count();
  const hasJobLinks = await page.locator('a[href*="/jobsearch/jobposting/"]').count();
  return recaptcha > 0 && hasJobLinks === 0;
}

async function humanize(page: Page): Promise<void> {
  await page.mouse.move(200 + Math.random() * 400, 220 + Math.random() * 240, { steps: 10 + Math.floor(Math.random() * 8) });
  await page.waitForTimeout(350 + Math.round(Math.random() * 450));
  await page.mouse.wheel(0, 300 + Math.round(Math.random() * 500));
  await page.waitForTimeout(350 + Math.round(Math.random() * 450));
}

async function loadAllResults(page: Page, maxLoops = 12): Promise<void> {
  for (let i = 0; i < maxLoops; i++) {
    const button = page.locator('#moreresultbutton').first();
    if (!(await button.isVisible().catch(() => false))) break;

    const beforeCount = await page.locator('article.action-buttons').count().catch(() => 0);
    await button.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(500 + Math.round(Math.random() * 500));
    await button.click({ timeout: 5000 }).catch(() => {});

    await page.waitForFunction(
      ({ selector, prev }) => document.querySelectorAll(selector).length > prev,
      { selector: 'article.action-buttons', prev: beforeCount },
      { timeout: 10_000 }
    ).catch(() => {});

    await page.waitForTimeout(1_000 + Math.round(Math.random() * 1_200));
  }
}

async function isResultsReady(page: Page): Promise<boolean> {
  return (await page.locator('a[href*="/jobsearch/jobposting/"]').first().isVisible().catch(() => false)) === true;
}

async function extractJobs(page: Page): Promise<Job[]> {
  return page.evaluate(() => {
    const jobs: Job[] = [];

    // Each result is an article.action-buttons containing anchor + details list
    const cards = Array.from(document.querySelectorAll('article.action-buttons'));

    const clean = (input?: string | null) => (input ? input.replace(/\s+/g, ' ').trim() : undefined);

    for (const card of cards) {
      const linkEl = card.querySelector('a.resultJobItem[href]') as HTMLAnchorElement | null;
      const titleEl = card.querySelector('span.noctitle') as HTMLElement | null;
      const employerEl = card.querySelector('li.business') as HTMLElement | null;
      const locationEl = card.querySelector('li.location') as HTMLElement | null;
      const dateEl = card.querySelector('li.date') as HTMLElement | null;
      const salaryEl = card.querySelector('li.salary') as HTMLElement | null;

      if (!titleEl || !linkEl) continue;

      const rawHref = linkEl.getAttribute('href') || linkEl.href || '';
      let url = '';
      try {
        const abs = new URL(rawHref, window.location.origin);
        abs.hash = '';
        url = abs.toString().replace(/;jsessionid=[^?]+/i, '');
      } catch (err) {
        url = rawHref;
      }

      const locText = locationEl?.textContent ? locationEl.textContent.replace(/Location/i, '') : undefined;
      const salaryText = salaryEl?.textContent ? salaryEl.textContent.replace(/Salary/i, '') : undefined;

      const job: Job = {
        title: clean(titleEl.textContent) || '',
        employer: clean(employerEl?.textContent) || '',
        location: clean(locText),
        date: clean(dateEl?.textContent),
        salary: clean(salaryText),
        url,
      };

      if (job.url && job.title) {
        jobs.push(job);
      }
    }

    return jobs;
  });
}

function deduplicateJobs(jobs: Job[]): Job[] {
  const seen = new Set<string>();
  return jobs.filter(job => {
    const canonical = canonicalizeUrl(job.url);
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  });
}

function canonicalizeUrl(input: string): string {
  try {
    const url = new URL(input);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/;jsessionid[^/]*?/i, '');
    return url.toString();
  } catch {
    return input.replace(/;jsessionid=[^?]+/i, '').split('#')[0].split('?')[0];
  }
}

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium-only test');

test('JobBank → bypass gates, capture screenshots, extract jobs', async () => {
  test.setTimeout(240_000);

  let lastErr: unknown;
  const MAX_ATTEMPTS = 3;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const context = await chromium.launchPersistentContext('/tmp/patchright_jobbank', {
      channel: 'chrome',
      headless: false,
      viewport: null,
      ignoreHTTPSErrors: true,
      args: ['--headless=new'],
    });

    const page = context.pages()[0] || (await context.newPage());

    try {
      await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.screenshot({ path: path.join(SHOTS_DIR, 'jobbank-before.png'), fullPage: true }).catch(() => {});
      await acceptConsent(page);

      for (let i = 0; i < 5; i++) {
        if (!(await looksLikeGate(page))) break;
        await humanize(page);
        await page.waitForTimeout(1_200 + Math.round(Math.random() * 800));
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await acceptConsent(page);
      }

      const start = Date.now();
      let ready = false;
      while (Date.now() - start < 15_000) {
        if (await isResultsReady(page)) {
          ready = true;
          break;
        }
        await page.waitForTimeout(600);
      }
      if (!ready) throw new Error('Results not ready in allotted time');

      await loadAllResults(page);

      // Dump HTML for selector debugging (overwrites each run)
      const dumpPath = path.resolve('data', 'jobbank-dump.html');
      await fs.promises.writeFile(dumpPath, await page.content(), 'utf8').catch(() => {});

      const jobs = await extractJobs(page);
      const unique = deduplicateJobs(jobs);
          
          for (const job of unique) {
            job.url = canonicalizeUrl(job.url);
          }

      await fs.promises.mkdir(path.dirname(OUT_PATH), { recursive: true });
      await fs.promises.writeFile(OUT_PATH, JSON.stringify(unique, null, 2), 'utf8');

      await page.screenshot({ path: path.join(SHOTS_DIR, 'jobbank-after.png'), fullPage: true });

      console.log(`✅ JobBank: extracted ${unique.length} unique jobs → ${OUT_PATH}`);
      await context.close();
      return;
    } catch (error) {
      lastErr = error;
      await page.screenshot({ path: path.join(SHOTS_DIR, `jobbank-failure-attempt-${attempt + 1}.png`), fullPage: true }).catch(() => {});
      console.warn(`Attempt ${attempt + 1} failed: ${String(error)}. Retrying…`);
      await context.close().catch(() => {});
    }
  }

  throw lastErr ?? new Error('Still gated on JobBank after attempts.');
});
