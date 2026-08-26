/** Web assembly coverage for the native Skill Center route and layout snapshots. */
import { mkdir, readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/skill-center', import.meta.url))
const CATALOG_EXPECTED = join(SNAPSHOT_DIR, 'catalog.expected.md')
const MODE = webSnapshotMode()
// The catalog golden uses an expired release; unit coverage owns the clock-sensitive New window.
const RESPONSE_FIXTURE_DIR = fileURLToPath(new URL('../../../packages/skill/skill-marketplace/tests/fixtures/', import.meta.url))
const RESPONSE_FIXTURES = [
  ['/api/web/skills', 'skills-page'],
  ['/api/web/labels', 'labels'],
  ['/api/web/skills/global/weather', 'skill-detail'],
  ['/api/web/skills/global/weather/versions/1.0.0', 'version-detail'],
] as const

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

  beforeAll(async () => {
    const responseBodies = new Map<string, string>(await Promise.all(RESPONSE_FIXTURES.map(async ([path, fixtureName]) => [
      path,
      await readFile(join(RESPONSE_FIXTURE_DIR, `${fixtureName}.json`), 'utf8'),
    ] as const)))
    skillHub = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://skillhub.test').pathname
      const body = responseBodies.get(path)
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
    expect(await page.getByRole('tab', { name: 'My Skills' }).isDisabled()).toBe(true)
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

  it('keeps cards inside the center surface on a mobile viewport', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'en-US' })
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skill-center-mobile'))
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Skill Center' }).click()
    await page.getByRole('heading', { name: 'Weather' }).waitFor({ timeout: 15_000 })
    const geometry = await page.getByRole('main', { name: 'Skill Center' }).evaluate((main) => {
      const card = main.querySelector('article')
      return {
        mainClientWidth: main.clientWidth,
        mainScrollWidth: main.scrollWidth,
        cardWidth: card?.getBoundingClientRect().width,
      }
    })
    expect(geometry.mainScrollWidth).toBe(geometry.mainClientWidth)
    expect(geometry.cardWidth).toBeLessThanOrEqual(geometry.mainClientWidth)
    await page.close()
  }, 60_000)
})
