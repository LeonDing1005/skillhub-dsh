import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import SkillMarketplace from '@deepseek-ai/dsh-skill-marketplace'
import { validateSkillHubOpenApi } from '../src/skillhub.ts'
import * as invariant from '../src/invariant.ts'

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

interface ResponseBodies {
  page: unknown
  labels: unknown
  detail: unknown
  version: unknown
}

interface OpenApiFixture {
  paths: Record<string, { get?: { parameters?: unknown; responses?: unknown } }>
  components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> }
}

const responseBodies = async (): Promise<ResponseBodies> => ({
  page: JSON.parse(await fixture('skills-page')) as unknown,
  labels: JSON.parse(await fixture('labels')) as unknown,
  detail: JSON.parse(await fixture('skill-detail')) as unknown,
  version: JSON.parse(await fixture('version-detail')) as unknown,
})

const marketplaceFor = (
  bodies: ResponseBodies,
  options: { baseUrl?: string; now?: () => Date } = {},
): { marketplace: SkillMarketplace; fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>> } => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const path = new URL(inputUrl(input)).pathname
    const body = path === '/api/web/skills'
      ? bodies.page
      : path === '/api/web/labels'
        ? bodies.labels
        : path === '/api/web/skills/global/weather'
          ? bodies.detail
          : bodies.version
    return Response.json(body)
  })
  return {
    marketplace: new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: options.baseUrl ?? 'https://skills.example.test' },
      { fetch, now: options.now ?? (() => new Date('2026-08-25T09:00:00Z')) },
    ),
    fetch,
  }
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

  it('forwards filters, parses labels, and omits an absent publication timestamp', async () => {
    const bodies = await responseBodies()
    const labels = bodies.labels as { data: unknown[] }
    const detail = bodies.detail as { data: { labels: unknown[] } }
    const version = bodies.version as { data: { publishedAt: unknown } }
    labels.data = [{ slug: 'utility', displayName: 'Utility' }]
    detail.data.labels = [{ slug: 'utility' }]
    version.data.publishedAt = null
    const { marketplace, fetch } = marketplaceFor(bodies, { baseUrl: 'https://skills.example.test/' })

    const page = await marketplace.list({ query: 'weather', label: 'utility', page: 0, pageSize: 1 })

    expect(inputUrl(fetch.mock.calls[0]![0])).toBe(
      'https://skills.example.test/api/web/skills?page=0&size=1&q=weather&label=utility',
    )
    expect(page.labels).toEqual([{ slug: 'utility', title: 'Utility' }])
    expect(page.items[0]).toMatchObject({ labels: ['utility'], isNew: false })
    expect(page.items[0]).not.toHaveProperty('publishedAt')
  })

  it.each([
    ['a negative page', { page: -1 }],
    ['a fractional page', { page: 0.5 }],
    ['a zero page size', { pageSize: 0 }],
    ['a fractional page size', { pageSize: 1.5 }],
  ])('rejects %s before contacting SkillHub', async (_name, request) => {
    const { marketplace, fetch } = marketplaceFor(await responseBodies())
    await expect(marketplace.list(request)).rejects.toBeInstanceOf(RangeError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['a changed detail namespace', 'detail', (data: Record<string, unknown>) => { data.namespace = 'other' }],
    ['a changed detail slug', 'detail', (data: Record<string, unknown>) => { data.slug = 'other' }],
    ['a changed version', 'version', (data: Record<string, unknown>) => { data.version = '2.0.0' }],
  ] as const)('rejects %s while enriching the catalog', async (_name, bodyName, mutate) => {
    const bodies = await responseBodies()
    mutate((bodies[bodyName] as { data: Record<string, unknown> }).data)
    const { marketplace } = marketplaceFor(bodies)
    await expect(marketplace.list({ pageSize: 1 })).rejects.toMatchObject({ code: 'SKILL_MARKETPLACE_INVALID_RESPONSE' })
  })

  it.each([
    ['a failed envelope', 'page', (body: Record<string, unknown>) => { body.code = 1 }],
    ['a non-object envelope', 'page', (_body: Record<string, unknown>, bodies: ResponseBodies) => { bodies.page = null }],
    ['a non-object page', 'page', (body: Record<string, unknown>) => { body.data = [] }],
    ['a non-array item list', 'page', (body: Record<string, unknown>) => { (body.data as Record<string, unknown>).items = {} }],
    ['a non-object item', 'page', (body: Record<string, unknown>) => { (body.data as { items: unknown[] }).items[0] = null }],
    ['a non-object published version', 'page', (body: Record<string, unknown>) => {
      ((body.data as { items: Array<Record<string, unknown>> }).items[0]!).publishedVersion = null
    }],
    ['a non-string namespace', 'page', (body: Record<string, unknown>) => {
      ((body.data as { items: Array<Record<string, unknown>> }).items[0]!).namespace = 1
    }],
    ['a non-number download count', 'page', (body: Record<string, unknown>) => {
      ((body.data as { items: Array<Record<string, unknown>> }).items[0]!).downloadCount = 'many'
    }],
    ['a non-array label list', 'labels', (body: Record<string, unknown>) => { body.data = {} }],
    ['a non-object label', 'labels', (body: Record<string, unknown>) => { body.data = [null] }],
    ['a non-string label slug', 'labels', (body: Record<string, unknown>) => { body.data = [{ slug: 1, displayName: 'One' }] }],
    ['a non-array detail label list', 'detail', (body: Record<string, unknown>) => {
      (body.data as Record<string, unknown>).labels = {}
    }],
    ['a non-object detail label', 'detail', (body: Record<string, unknown>) => {
      (body.data as Record<string, unknown>).labels = [null]
    }],
    ['a non-string detail label slug', 'detail', (body: Record<string, unknown>) => {
      (body.data as Record<string, unknown>).labels = [{ slug: 1 }]
    }],
    ['an invalid publication timestamp type', 'version', (body: Record<string, unknown>) => {
      (body.data as Record<string, unknown>).publishedAt = 1
    }],
  ] as const)('rejects %s from SkillHub', async (_name, bodyName, mutate) => {
    const bodies = await responseBodies()
    mutate(bodies[bodyName] as Record<string, unknown>, bodies)
    const { marketplace } = marketplaceFor(bodies)
    await expect(marketplace.list({ pageSize: 1 })).rejects.toMatchObject({ code: 'SKILL_MARKETPLACE_INVALID_RESPONSE' })
  })

  it.each([
    ['an invalid timestamp', 'not-a-date', new Date('2026-08-25T09:00:00Z')],
    ['a future timestamp', '2026-08-26T09:00:00Z', new Date('2026-08-25T09:00:00Z')],
    ['an invalid Host clock', '2026-08-19T09:00:00Z', new Date(Number.NaN)],
  ])('does not mark %s as new', async (_name, publishedAt, now) => {
    const bodies = await responseBodies()
    ;(bodies.version as { data: { publishedAt: string } }).data.publishedAt = publishedAt
    const { marketplace } = marketplaceFor(bodies, { now: () => now })
    await expect(marketplace.list({ pageSize: 1 })).resolves.toMatchObject({ items: [{ isNew: false }] })
  })

  it('classifies network, HTTP, and JSON failures without losing their cause', async () => {
    const networkCause = new Error('offline')
    const network = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test' },
      { fetch: vi.fn(async () => { throw networkCause }), now: () => new Date() },
    )
    await expect(network.list()).rejects.toMatchObject({ code: 'SKILL_MARKETPLACE_UPSTREAM', cause: networkCause })

    const http = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test' },
      { fetch: vi.fn(async () => new Response('unavailable', { status: 503 })), now: () => new Date() },
    )
    await expect(http.list()).rejects.toMatchObject({ code: 'SKILL_MARKETPLACE_UPSTREAM' })

    const invalidJson = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test' },
      { fetch: vi.fn(async () => new Response('{')), now: () => new Date() },
    )
    await expect(invalidJson.list()).rejects.toMatchObject({ code: 'SKILL_MARKETPLACE_INVALID_RESPONSE' })
  })
})

describe('SkillMarketplace configuration', () => {
  it.each([
    ['an empty Registry Instance id', { registryInstanceId: ' ', baseUrl: 'https://skills.example.test' }],
    ['a non-HTTP URL', { registryInstanceId: 'public-skillhub', baseUrl: 'ftp://skills.example.test' }],
    ['a URL username', { registryInstanceId: 'public-skillhub', baseUrl: 'https://user@skills.example.test' }],
    ['a URL password', { registryInstanceId: 'public-skillhub', baseUrl: 'https://:secret@skills.example.test' }],
    ['a zero page limit', { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', pageSizeLimit: 0 }],
    ['a fractional page limit', { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', pageSizeLimit: 1.5 }],
  ])('rejects %s', (_name, config) => {
    expect(() => new SkillMarketplace(new Context(), config)).toThrow()
  })

  it('uses the production fetch and Host clock defaults', async () => {
    const bodies = await responseBodies()
    const { fetch } = marketplaceFor(bodies)
    vi.stubGlobal('fetch', fetch)
    try {
      const marketplace = new SkillMarketplace(new Context(), {
        registryInstanceId: 'public-skillhub',
        baseUrl: 'http://skills.example.test',
      })
      await expect(marketplace.list({ pageSize: 1 })).resolves.toMatchObject({ total: 17 })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('deployed SkillHub OpenAPI fixture', () => {
  it('contains every path and response field consumed by the adapter', async () => {
    const openapi = JSON.parse(await fixture('openapi-marketplace')) as unknown
    expect(() => { validateSkillHubOpenApi(openapi) }).not.toThrow()
  })

  it.each([
    ['a required path', (openapi: OpenApiFixture) => { delete openapi.paths['/api/web/labels'] }],
    ['a GET operation', (openapi: OpenApiFixture) => { delete openapi.paths['/api/web/labels']!.get }],
    ['operation responses', (openapi: OpenApiFixture) => { delete openapi.paths['/api/web/labels']!.get!.responses }],
    ['the parameter list', (openapi: OpenApiFixture) => { openapi.paths['/api/web/skills']!.get!.parameters = {} }],
    ['a parameter object', (openapi: OpenApiFixture) => {
      ;(openapi.paths['/api/web/skills']!.get!.parameters as unknown[])[0] = null
    }],
    ['a required parameter', (openapi: OpenApiFixture) => {
      ;(openapi.paths['/api/web/skills']!.get!.parameters as unknown[]).pop()
    }],
    ['components', (openapi: OpenApiFixture) => { delete openapi.components }],
    ['schemas', (openapi: OpenApiFixture) => { delete openapi.components!.schemas }],
    ['a required schema', (openapi: OpenApiFixture) => { delete openapi.components!.schemas!.SearchResponse }],
    ['schema properties', (openapi: OpenApiFixture) => {
      delete openapi.components!.schemas!.SearchResponse!.properties
    }],
    ['a required schema field', (openapi: OpenApiFixture) => {
      delete openapi.components!.schemas!.SearchResponse!.properties!.items
    }],
  ])('rejects an OpenAPI document missing %s', async (_name, mutate) => {
    const openapi = JSON.parse(await fixture('openapi-marketplace')) as OpenApiFixture
    mutate(openapi)
    expect(() => { validateSkillHubOpenApi(openapi) }).toThrow(/SkillHub/)
  })
})

describe('skill marketplace invariant companion', () => {
  it('registers and disposes under the package name', async () => {
    const dispose = vi.fn()
    const register = vi.fn().mockReturnValue(dispose)
    const ctx = { invariants: { register } } as never

    await expect(invariant.apply(ctx)).resolves.toBe(dispose)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-skill-marketplace', expect.any(Function))
    expect(() => { (register.mock.calls[0]![1] as () => void)() }).not.toThrow()
  })
})
