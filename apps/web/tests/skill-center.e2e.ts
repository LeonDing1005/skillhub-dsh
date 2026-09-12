/** Web assembly coverage for the native Skill Center route and layout snapshots. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { strToU8, zipSync } from 'fflate'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/skill-center', import.meta.url))
const CATALOG_EXPECTED = join(SNAPSHOT_DIR, 'catalog.expected.md')
// Linux and macOS use different system font rasterizers. Keep the visual
// comparison strict by selecting a golden produced by the current renderer;
// refresh mode writes the same platform-specific path.
const DETAIL_SNAPSHOT_SUFFIX = process.platform === 'linux' ? '.linux' : ''
function detailSnapshot(name: string): string {
  return join(SNAPSHOT_DIR, `${name}${DETAIL_SNAPSHOT_SUFFIX}.expected.png`)
}
const DETAIL_DSH_EXPECTED = detailSnapshot('detail-dsh')
const DETAIL_LOCAL_EXPECTED = detailSnapshot('detail-local')
const DETAIL_COPIED_EXPECTED = detailSnapshot('detail-copied')
const DETAIL_LONG_EXPECTED = detailSnapshot('detail-long')
const MODE = webSnapshotMode()
// The catalog golden uses an expired release; unit coverage owns the clock-sensitive New window.
const RESPONSE_FIXTURE_DIR = fileURLToPath(new URL('../../../packages/skill/skill-marketplace/tests/fixtures/', import.meta.url))

interface CatalogGeometry {
  main: { width: number; height: number }
  grid: { columns: string; gap: string }
  card: { width: number; height: number }
}

async function catalogGeometry(page: Page): Promise<CatalogGeometry> {
  return page.getByRole('main', { name: /Skill Center|技能中心/ }).evaluate((main) => {
    const card = main.querySelector<HTMLElement>('article')
    if (card === null || card.parentElement === null) {
      throw new Error('Skill Center catalog geometry is incomplete')
    }
    const grid = card.parentElement
    const mainRect = main.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    const gridStyle = getComputedStyle(grid)
    return {
      main: { width: mainRect.width, height: mainRect.height },
      grid: { columns: gridStyle.gridTemplateColumns, gap: gridStyle.gap },
      card: { width: cardRect.width, height: cardRect.height },
    }
  })
}

describe('web e2e: Skill Center', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let skillHub: Server
  let englishGeometry: CatalogGeometry
  let registryMode: 'normal' | 'offline' | 'next-failure' = 'normal'
  let rateLimitRemaining = 0
  let releaseSlow: (() => void) | undefined
  let slowAborted = false
  let slowStarted: Promise<void>
  let markSlowStarted: () => void
  const listRequests: URL[] = []
  const downloadRequests: string[] = []
  let expectedZipBytes: Buffer

  beforeAll(async () => {
    const pageFixture = JSON.parse(await readFile(join(RESPONSE_FIXTURE_DIR, 'skills-page.json'), 'utf8')) as {
      data: { items: Array<{ slug: string; displayName: string }>; page: number }
    }
    const detailFixture = JSON.parse(await readFile(join(RESPONSE_FIXTURE_DIR, 'skill-detail.json'), 'utf8')) as {
      data: { slug: string; labels: Array<{ slug: string }> }
    }
    const labelsFixture = { code: 0, data: [{ slug: 'utilities', displayName: 'Utilities' }] }
    detailFixture.data.labels = [{ slug: 'utilities' }]
    const forecastPage = structuredClone(pageFixture)
    forecastPage.data.page = 1
    forecastPage.data.items[0]!.slug = 'forecast'
    forecastPage.data.items[0]!.displayName = 'Forecast'
    const forecastDetail = structuredClone(detailFixture)
    forecastDetail.data.slug = 'forecast'
    const versionFixture = JSON.parse(await readFile(join(RESPONSE_FIXTURE_DIR, 'version-detail.json'), 'utf8')) as {
      data: { parsedMetadataJson: string }
    }
    versionFixture.data.parsedMetadataJson = JSON.stringify({
      name: 'weather-toolkit',
      metadata: { examplePrompt: 'Will it rain in Shenzhen tomorrow?' },
    })
    const versionBody = JSON.stringify(versionFixture)
    const versionListBody = JSON.stringify({
      code: 0,
      data: {
        items: [{ version: '1.0.0', publishedAt: '2026-08-19T08:57:33.532872Z', downloadAvailable: true }],
        total: 1,
        page: 0,
        size: 20,
      },
    })
    const resolveBody = JSON.stringify({
      code: 0,
      data: {
        namespace: 'global', slug: 'weather', version: '1.0.0', matched: true,
        downloadUrl: '/api/web/skills/global/weather/versions/1.0.0/download',
      },
    })
    const skillMarkdown = [
      '# Weather toolkit',
      '',
      'Retrieve forecasts without exposing Registry Instance credentials.',
      '',
      '<iframe src="https://example.test/embed"></iframe>',
      '',
      '![remote](https://example.test/tracker.png)',
      '',
      '```text',
      'a'.repeat(180),
      '```',
    ].join('\n')
    const skillBytes = strToU8(skillMarkdown)
    const zipBytes = Buffer.from(zipSync({ 'SKILL.md': skillBytes }))
    expectedZipBytes = zipBytes
    const filesBody = JSON.stringify({
      code: 0,
      data: [{
        filePath: 'SKILL.md',
        fileSize: skillBytes.byteLength,
        contentType: 'text/markdown',
        sha256: createHash('sha256').update(skillBytes).digest('hex'),
      }],
    })
    const staticBodies = new Map<string, string>([
      ['/api/web/labels', JSON.stringify(labelsFixture)],
      ['/api/web/skills/global/weather', JSON.stringify(detailFixture)],
      ['/api/web/skills/global/weather/versions/1.0.0', versionBody],
      ['/api/web/skills/global/weather/versions', versionListBody],
      ['/api/web/skills/global/weather/versions/1.0.0/files', filesBody],
      ['/api/web/skills/global/weather/versions/1.0.0/file', skillMarkdown],
      ['/api/web/skills/global/weather/resolve', resolveBody],
      ['/api/web/skills/global/forecast', JSON.stringify(forecastDetail)],
      ['/api/web/skills/global/forecast/versions/1.0.0', versionBody],
    ])
    slowStarted = new Promise((resolve) => { markSlowStarted = resolve })
    skillHub = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://skillhub.test')
      const path = url.pathname
      if (path === '/api/web/skills') {
        listRequests.push(url)
        if (registryMode === 'offline' || (registryMode === 'next-failure' && url.searchParams.get('page') === '1')) {
          response.writeHead(503)
          response.end()
          return
        }
        if (url.searchParams.get('q') === 'rate' && rateLimitRemaining > 0) {
          rateLimitRemaining -= 1
          response.writeHead(429, { 'retry-after': '900' })
          response.end()
          return
        }
        const body = structuredClone(url.searchParams.get('page') === '1' ? forecastPage : pageFixture)
        const query = url.searchParams.get('q')
        if (query !== null && body.data.items[0] !== undefined) body.data.items[0].displayName = `${query[0]!.toUpperCase()}${query.slice(1)} result`
        if (query === 'slow') {
          request.once('aborted', () => { slowAborted = true })
          releaseSlow = () => { writeJson(response, body) }
          markSlowStarted()
          return
        }
        writeJson(response, body)
        return
      }
      if (path === '/api/web/skills/global/weather/versions/1.0.0/download') {
        downloadRequests.push(request.method ?? 'GET')
        response.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(zipBytes.byteLength) })
        response.end(zipBytes)
        return
      }
      const body = staticBodies.get(path)
      response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'application/json' })
      response.end(body ?? '{"error":"not found"}')
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { reject(error) }
      skillHub.once('error', onError)
      skillHub.listen(0, '127.0.0.1', () => {
        skillHub.off('error', onError)
        resolve()
      })
    })
    const address = skillHub.address() as AddressInfo
    scaffold = await launchWebScaffold({
      skillHub: {
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        registryInstanceId: 'public-skillhub',
        freshTtlMs: 0,
        staleTtlMs: 2_000,
        rateLimitBackoffMs: 1,
      },
    })
    browser = await chromium.launch()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await new Promise<void>((resolve, reject) => {
      if (!skillHub?.listening) { resolve(); return }
      skillHub.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
  })

  it('opens the Host-backed Community Skills catalog and returns to a conversation', async () => {
    const page = await browser.newPage({ viewport: { width: 1357, height: 638 }, locale: 'en-US' })
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skill-center'))
    const tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Skill Center' }).click()
    await page.getByRole('heading', { name: 'Weather' }).waitFor({ timeout: 15_000 })

    expect(await page.getByRole('tab', { name: 'Community Skills' }).getAttribute('aria-selected')).toBe('true')
    expect(await page.getByRole('tab', { name: 'My Skills' }).isDisabled()).toBe(false)
    expect(await page.getByLabel('0 stars').count()).toBe(1)
    expect(await page.getByLabel('0 downloads').count()).toBe(1)
    const aria = await captureStableAria(page, 'main[aria-label="Skill Center"]', scaffold.workspaceCwd)
    if (MODE === 'refresh') await mkdir(SNAPSHOT_DIR, { recursive: true })
    await compareOrRefreshGolden(CATALOG_EXPECTED, aria, MODE)
    englishGeometry = await catalogGeometry(page)

    await page.getByRole('button', { name: /^(?:New session|新.*会话)$/ }).last().click()
    await page.locator('[data-conversation-scroll]').waitFor({ timeout: 15_000 })
    expect(await page.getByRole('main', { name: 'Skill Center' }).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    await page.close()
  }, 60_000)

  it('keeps the same catalog geometry under Chinese copy', async () => {
    const page = await browser.newPage({ viewport: { width: 1357, height: 638 }, locale: 'zh-CN' })
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skill-center-zh'))
    const tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: '技能中心' }).click()
    await page.getByRole('heading', { name: 'Weather' }).waitFor({ timeout: 15_000 })
    const chineseGeometry = await catalogGeometry(page)
    expect({ ...chineseGeometry, card: { width: chineseGeometry.card.width } }).toEqual({
      ...englishGeometry,
      card: { width: englishGeometry.card.width },
    })
    expect(Math.abs(chineseGeometry.card.height - englishGeometry.card.height)).toBeLessThanOrEqual(4)
    expect(tripwire.pageErrors).toEqual([])
    await page.close()
  }, 60_000)

  it('recovers discovery across filtering, pagination, cancellation, rate limits, and stale cache', async () => {
    const page = await browser.newPage({ viewport: { width: 1357, height: 638 }, locale: 'en-US' })
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skill-center-recovery'))
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Skill Center' }).click()
    await page.getByRole('heading', { name: 'Weather' }).waitFor({ timeout: 15_000 })

    await page.getByRole('searchbox', { name: 'Search Community Skills' }).fill('weather')
    await page.getByRole('button', { name: 'Utilities' }).click()
    await page.getByRole('combobox', { name: 'Sort Community Skills' }).selectOption('downloads')
    await expect.poll(() => listRequests.some(url =>
      url.searchParams.get('q') === 'weather'
      && url.searchParams.get('label') === 'utilities'
      && url.searchParams.get('sort') === 'downloads'
      && url.searchParams.get('page') === '0')).toBe(true)

    const resetRequestStart = listRequests.length
    await page.getByRole('searchbox', { name: 'Search Community Skills' }).fill('')
    await page.getByRole('button', { name: 'All' }).click()
    await page.getByRole('combobox', { name: 'Sort Community Skills' }).selectOption('newest')
    await expect.poll(() => listRequests.slice(resetRequestStart).some(url =>
      url.searchParams.get('q') === null
      && url.searchParams.get('label') === null
      && url.searchParams.get('sort') === 'newest'
      && url.searchParams.get('page') === '0')).toBe(true)
    await page.getByRole('heading', { name: 'Weather' }).waitFor()
    registryMode = 'next-failure'
    await page.getByRole('button', { name: 'Load more' }).click()
    await page.getByText('Could not load the next page').waitFor()
    expect(listRequests.filter(url => url.searchParams.get('page') === '1')).toHaveLength(1)
    expect(await page.getByRole('heading', { name: 'Weather' }).count()).toBe(1)
    registryMode = 'normal'
    await page.getByRole('button', { name: 'Retry next page' }).click()
    await expect.poll(() => listRequests.filter(url => url.searchParams.get('page') === '1').length).toBe(2)
    await page.getByRole('heading', { name: 'Forecast' }).waitFor()

    await page.getByRole('searchbox', { name: 'Search Community Skills' }).fill('slow')
    await slowStarted
    await page.getByRole('searchbox', { name: 'Search Community Skills' }).fill('fast')
    await page.getByRole('heading', { name: 'Fast result' }).waitFor()
    await expect.poll(() => slowAborted).toBe(true)
    releaseSlow?.()
    expect(await page.getByRole('heading', { name: 'Slow result' }).count()).toBe(0)

    rateLimitRemaining = 2
    await page.getByRole('searchbox', { name: 'Search Community Skills' }).fill('rate')
    await page.getByRole('heading', { name: 'Rate result' }).waitFor()
    expect(rateLimitRemaining).toBe(0)

    await page.getByRole('searchbox', { name: 'Search Community Skills' }).fill('cache')
    await page.getByRole('heading', { name: 'Cache result' }).waitFor()
    registryMode = 'offline'
    await page.getByRole('searchbox', { name: 'Search Community Skills' }).fill('cache-miss')
    await page.getByText('Community Skills unavailable').waitFor()
    await page.getByRole('searchbox', { name: 'Search Community Skills' }).fill('cache')
    await page.getByText(/Last successful refresh:/).waitFor()
    expect(await page.getByRole('heading', { name: 'Cache result' }).count()).toBe(1)

    await new Promise(resolve => setTimeout(resolve, 2_100))
    await page.getByRole('button', { name: 'Retry' }).click()
    await page.getByText('Community Skills unavailable').waitFor()
    registryMode = 'normal'
    await page.close()
  }, 60_000)

  it('uses stable wide, medium, and narrow card tracks without horizontal overflow', async () => {
    for (const [width, columns] of [[1357, 3], [900, 2], [390, 1]] as const) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, locale: 'en-US' })
      onTestFailed(() => saveFailureShot(page, `web-e2e-skill-center-${width}`))
      await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await page.getByRole('button', { name: 'Skill Center' }).click()
      await page.getByRole('heading', { name: 'Weather' }).waitFor({ timeout: 15_000 })
      const geometry = await page.getByRole('main', { name: 'Skill Center' }).evaluate((main) => {
        const card = main.querySelector('article')
        const grid = card?.parentElement
        return {
          mainClientWidth: main.clientWidth,
          mainScrollWidth: main.scrollWidth,
          cardWidth: card?.getBoundingClientRect().width,
          columns: grid === null || grid === undefined ? 0 : getComputedStyle(grid).gridTemplateColumns.split(' ').length,
        }
      })
      expect(geometry.columns).toBe(columns)
      expect(geometry.mainScrollWidth).toBe(geometry.mainClientWidth)
      expect(geometry.cardWidth).toBeLessThanOrEqual(geometry.mainClientWidth)
      await page.close()
    }
  }, 60_000)

  it('keeps exact-release detail modes visually stable and bounded', async () => {
    const page = await browser.newPage({ viewport: { width: 802, height: 638 }, locale: 'en-US' })
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: scaffold.baseUrl })
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skill-detail'))
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Skill Center' }).click()
    await page.getByRole('heading', { name: 'Weather' }).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: 'View details for Weather' }).click()
    const dialog = page.getByRole('dialog', { name: 'weather-toolkit' })
    await dialog.waitFor({ timeout: 15_000 })
    const detailLayer = page.getByTestId('skill-detail-layer')
    await page.addStyleTag({ content: [
      '[data-testid="skill-detail-layer"] { background: #d9d9d9; }',
      '[data-testid="skill-detail-layer"] > [aria-hidden="true"] { background: transparent; backdrop-filter: none; }',
    ].join('\n') })
    await page.evaluate(() => document.fonts.ready)
    expect(await dialog.locator('img').count()).toBe(0)
    expect(await dialog.getByText(/iframe src=/).count()).toBe(1)
    await compareOrRefreshPng(DETAIL_DSH_EXPECTED, await detailLayer.screenshot(), MODE)

    await page.getByRole('button', { name: 'Local / third-party installation' }).click()
    await page.getByText('skillhub install weather --namespace global --version 1.0.0').waitFor()
    await compareOrRefreshPng(DETAIL_LOCAL_EXPECTED, await detailLayer.screenshot(), MODE)

    await page.getByRole('button', { name: 'Copy install command' }).click()
    await page.getByText('Copied').waitFor()
    await compareOrRefreshPng(DETAIL_COPIED_EXPECTED, await detailLayer.screenshot(), MODE)

    await page.setViewportSize({ width: 807, height: 638 })
    const overflow = await dialog.evaluate(element => ({
      width: element.getBoundingClientRect().width,
      viewportWidth: document.documentElement.clientWidth,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }))
    expect(overflow.width).toBeLessThanOrEqual(overflow.viewportWidth)
    expect(overflow.scrollWidth).toBe(overflow.clientWidth)
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
    }))
    await compareOrRefreshPng(DETAIL_LONG_EXPECTED, await detailLayer.screenshot(), MODE)

    const downloadStarted = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download locally' }).click()
    const saved = await downloadStarted
    expect(saved.suggestedFilename()).toBe('weather-toolkit-1.0.0.zip')
    const savedPath = await saved.path()
    if (savedPath === null) throw new Error('Skill Center browser download did not produce a local artifact')
    expect(await readFile(savedPath)).toEqual(expectedZipBytes)
    expect(downloadRequests).toEqual(['GET'])
    await page.close()
  }, 60_000)
})

function writeJson(response: ServerResponse, body: unknown): void {
  if (response.destroyed) return
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function compareOrRefreshPng(path: string, actual: Buffer, mode: ReturnType<typeof webSnapshotMode>): Promise<void> {
  if (mode === 'refresh') {
    await mkdir(SNAPSHOT_DIR, { recursive: true })
    await writeFile(path, actual)
    return
  }
  const expected = await readFile(path)
  const expectedPng = PNG.sync.read(expected)
  const actualPng = PNG.sync.read(actual)
  expect({ width: actualPng.width, height: actualPng.height }).toEqual({
    width: expectedPng.width,
    height: expectedPng.height,
  })
  const changed = pixelmatch(expectedPng.data, actualPng.data, undefined, actualPng.width, actualPng.height, {
    includeAA: false,
    threshold: 0.1,
  })
  const ratio = changed / (actualPng.width * actualPng.height)
  expect(ratio, `visual snapshot differs by ${(ratio * 100).toFixed(3)}%: ${path}`).toBeLessThanOrEqual(0.002)
}
