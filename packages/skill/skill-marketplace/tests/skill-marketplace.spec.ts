import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import SkillMarketplace from '@deepseek-ai/dsh-skill-marketplace'
import { validateSkillHubOpenApi } from '../src/skillhub.ts'

const fixture = async (name: string): Promise<string> =>
  readFile(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8')

const inputUrl = (input: string | URL | Request): string => {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

interface SkillPageFixtureData {
  items: Array<{ downloadCount: number; starCount: number }>
  total: number
  page: number
  size: number
}

describe('SkillMarketplace.list', () => {
  it('normalizes one deployed SkillHub catalog page without inventing a view metric', async () => {
    const responses = new Map([
      ['/api/web/skills?page=0&size=1', await fixture('skills-page')],
      ['/api/web/labels', await fixture('labels')],
      ['/api/web/skills/global/weather', await fixture('skill-detail')],
      ['/api/web/skills/global/weather/versions/1.0.0', await fixture('version-detail')],
    ])
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(inputUrl(input))
      const body = responses.get(`${url.pathname}${url.search}`)
      if (body === undefined) return new Response('not found', { status: 404 })
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const marketplace = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', pageSizeLimit: 20 },
      { fetch, now: () => new Date('2026-08-25T09:00:00Z') },
    )

    await expect(marketplace.list({ pageSize: 1 })).resolves.toEqual({
      items: [{
        identity: {
          registryInstanceId: 'public-skillhub',
          namespace: 'global',
          slug: 'weather',
          version: '1.0.0',
        },
        title: 'weather',
        description: 'Retrieve and summarize current weather and forecasts for locations, rain, temperature, and travel planning using an available web tool or wttr.in over HTTPS.',
        publisher: 'Built-in Skill Publisher',
        starCount: 0,
        downloadCount: 0,
        labels: [],
        publishedAt: '2026-08-19T08:57:33.532872Z',
        isNew: true,
      }],
      labels: [],
      total: 17,
      page: 0,
      pageSize: 1,
    })
    expect(fetch.mock.calls.map(([input]) => inputUrl(input))).toEqual([
      'https://skills.example.test/api/web/skills?page=0&size=1',
      'https://skills.example.test/api/web/labels',
      'https://skills.example.test/api/web/skills/global/weather',
      'https://skills.example.test/api/web/skills/global/weather/versions/1.0.0',
    ])
  })

  it('rejects out-of-range pagination before contacting SkillHub', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const marketplace = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', pageSizeLimit: 20 },
      { fetch, now: () => new Date('2026-08-25T09:00:00Z') },
    )
    await expect(marketplace.list({ pageSize: 21 })).rejects.toThrow(/between 1 and 20/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not mark a trustworthy publication older than seven Host-clock days as new', async () => {
    const responses = new Map([
      ['/api/web/skills?page=0&size=1', await fixture('skills-page')],
      ['/api/web/labels', await fixture('labels')],
      ['/api/web/skills/global/weather', await fixture('skill-detail')],
      ['/api/web/skills/global/weather/versions/1.0.0', await fixture('version-detail')],
    ])
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(inputUrl(input))
      const body = responses.get(`${url.pathname}${url.search}`)
      if (body === undefined) return new Response('not found', { status: 404 })
      return new Response(body, { status: 200 })
    })
    const marketplace = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', pageSizeLimit: 20 },
      { fetch, now: () => new Date('2026-09-01T09:00:00Z') },
    )

    const page = await marketplace.list({ pageSize: 1 })
    expect(page.items[0]?.isNew).toBe(false)
  })

  it('preserves caller cancellation instead of translating it into an upstream failure', async () => {
    const controller = new AbortController()
    const reason = new DOMException('cancelled by caller', 'AbortError')
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      controller.abort(reason)
      throw init?.signal?.reason
    })
    const marketplace = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test' },
      { fetch, now: () => new Date('2026-08-25T09:00:00Z') },
    )
    await expect(marketplace.list({}, controller.signal)).rejects.toBe(reason)
  })

  it('preserves cancellation that arrives while reading the response body', async () => {
    const controller = new AbortController()
    const reason = new DOMException('cancelled while reading', 'AbortError')
    const response = new Response('{}', { status: 200 })
    vi.spyOn(response, 'json').mockImplementation(async () => {
      controller.abort(reason)
      throw reason
    })
    const marketplace = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test' },
      { fetch: vi.fn(async () => response), now: () => new Date('2026-08-25T09:00:00Z') },
    )

    await expect(marketplace.list({}, controller.signal)).rejects.toBe(reason)
  })

  it.each([
    ['negative download count', (data: SkillPageFixtureData) => { data.items[0]!.downloadCount = -1 }],
    ['fractional star count', (data: SkillPageFixtureData) => { data.items[0]!.starCount = 0.5 }],
    ['negative total', (data: SkillPageFixtureData) => { data.total = -1 }],
    ['fractional page', (data: SkillPageFixtureData) => { data.page = 0.5 }],
    ['zero page size', (data: SkillPageFixtureData) => { data.size = 0 }],
  ])('rejects a %s at the Host parser boundary', async (_name, mutate) => {
    const envelope = JSON.parse(await fixture('skills-page')) as { data: SkillPageFixtureData }
    mutate(envelope.data)
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(inputUrl(input))
      const body = url.pathname === '/api/web/labels'
        ? await fixture('labels')
        : url.pathname === '/api/web/skills/global/weather'
          ? await fixture('skill-detail')
          : url.pathname === '/api/web/skills/global/weather/versions/1.0.0'
            ? await fixture('version-detail')
            : JSON.stringify(envelope)
      return new Response(body, { status: 200 })
    })
    const marketplace = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test' },
      { fetch, now: () => new Date('2026-08-25T09:00:00Z') },
    )

    await expect(marketplace.list({ pageSize: 1 })).rejects.toMatchObject({ code: 'SKILL_MARKETPLACE_INVALID_RESPONSE' })
  })

  it('classifies malformed deployed responses at the Host parser boundary', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response('{"code":0,"data":{"items":"not-an-array"}}', { status: 200 }))
    const marketplace = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test' },
      { fetch, now: () => new Date('2026-08-25T09:00:00Z') },
    )
    await expect(marketplace.list()).rejects.toMatchObject({ code: 'SKILL_MARKETPLACE_INVALID_RESPONSE' })
  })
})

describe('deployed SkillHub OpenAPI fixture', () => {
  it('contains every path and response field consumed by the adapter', async () => {
    const openapi = JSON.parse(await fixture('openapi-marketplace')) as unknown
    expect(() => { validateSkillHubOpenApi(openapi) }).not.toThrow()
  })
})
