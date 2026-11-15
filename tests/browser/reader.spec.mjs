import { test, expect } from '@playwright/test';

test('qualified search opens the exact article and keeps a bookmark after reload', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#article-heading')).toHaveText('第一条');
  await page.locator('#query').fill('民法 ７０９条 故意');
  await page.locator('#site-search button[type=submit]').click();
  const results = page.locator('#search-results .result-item');
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText('第七百九条');
  await results.first().click();
  await expect(page).toHaveURL(/law=civil&article=709/);
  await expect(page.locator('#article-heading')).toHaveText('第七百九条');
  await expect(page.locator('#article-parts')).toContainText('故意又は過失');
  await page.locator('#bookmark-article').click();
  await expect(page.locator('#bookmark-article')).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.locator('#bookmark-article')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#saved-articles .saved-link')).toContainText('第七百九条');
  await page.locator('#focus-reading').click();
  await expect(page.locator('body')).toHaveClass(/reading-focus/);
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/reading-focus/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('paragraph links, browser history and full-text editions retain the requested provision', async ({ page }) => {
  await page.goto('/?law=civil&article=1&part=2');
  await expect(page.locator('#article-heading')).toHaveText('第一条');
  await expect(page.locator('[id="part-2"]')).toHaveClass(/is-selected/);
  await expect(page.locator('[id="part-2"]')).toContainText('信義に従い誠実に');
  await page.locator('#next-article').click();
  await expect(page.locator('#article-heading')).toHaveText('第二条');
  await page.goBack();
  await expect(page.locator('[id="part-2"]')).toHaveClass(/is-selected/);
  await page.goto('/read/civil.html#a-709');
  await expect(page.locator('#a-709')).toContainText('故意又は過失');
  await page.locator('#a-709 .edition-link').click();
  await expect(page.locator('#article-heading')).toHaveText('第七百九条');
});

test('a failed search data request reports incomplete coverage and recovers on retry', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#article-heading')).toHaveText('第一条');
  const blockCivil = route => route.fulfill({ status: 503, body: 'temporarily unavailable' });
  await page.route('**/data/civil.json', blockCivil);
  await page.locator('#query').fill('民法709条');
  await page.locator('#site-search button[type=submit]').click();
  await expect(page.locator('#search-results')).toContainText('5法のデータを検索しました');
  await expect(page.locator('#search-results .result-item')).toHaveCount(0);
  await page.unroute('**/data/civil.json', blockCivil);
  await page.locator('#site-search button[type=submit]').click();
  await expect(page.locator('#search-results .result-item')).toHaveCount(1);
  await expect(page.locator('#search-results')).not.toContainText('5法のデータを検索しました');
});

test('failed navigation hides the previous statute and retries the requested law', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#article-heading')).toHaveText('第一条');
  const blockCivil = route => route.fulfill({ status: 503, body: 'temporarily unavailable' });
  await page.route('**/data/civil.json', blockCivil);
  await page.locator('#law-list [data-law=civil]').click();
  await expect(page).toHaveURL(/law=civil/);
  await expect(page.locator('.reader-grid')).toBeHidden();
  await expect(page.locator('#route-message')).toContainText('民法を読み込めませんでした');
  await expect(page.locator('#route-retry')).toBeVisible();
  await page.unroute('**/data/civil.json', blockCivil);
  await page.locator('#route-retry').click();
  await expect(page.locator('.reader-grid')).toBeVisible();
  await expect(page.locator('#article-meta')).toContainText('民法');
  await expect(page.locator('#article-parts')).toContainText('私権は、公共の福祉に適合しなければならない');
  await expect(page.locator('#route-status')).toBeHidden();
});
