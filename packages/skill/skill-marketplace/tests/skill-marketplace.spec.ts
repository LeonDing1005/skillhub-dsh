import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { strToU8, Zip, ZipDeflate, zipSync } from 'fflate'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import SkillMarketplace, { registryInstanceId } from '@deepseek-ai/dsh-skill-marketplace'
import { validateSkillHubOpenApi } from '../src/skillhub.ts'
import * as invariant from '../src/invariant.ts'

const fixture = async (name: string): Promise<string> =>
  readFile(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8')

const inputUrl = (input: string | URL | Request): string => {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

const changedCentralName = (archive: Uint8Array): Uint8Array => {
  const changed = archive.slice()
  for (let index = 0; index <= changed.byteLength - 4; index += 1) {
    if (changed[index] === 0x50 && changed[index + 1] === 0x4b
      && changed[index + 2] === 0x01 && changed[index + 3] === 0x02) {
      changed[index + 46] = 'X'.charCodeAt(0)
      return changed
    }
  }
  throw new Error('test ZIP has no central directory entry')
}

const changedCentralCrc = (archive: Uint8Array): Uint8Array => {
  const changed = archive.slice()
  for (let index = 0; index <= changed.byteLength - 20; index += 1) {
    if (changed[index] === 0x50 && changed[index + 1] === 0x4b
      && changed[index + 2] === 0x01 && changed[index + 3] === 0x02) {
      const view = new DataView(changed.buffer, changed.byteOffset + index)
      view.setUint32(16, view.getUint32(16, true) ^ 0xff, true)
      return changed
    }
  }
  throw new Error('test ZIP has no central directory entry')
}

const changedAllCrcs = (archive: Uint8Array): Uint8Array => {
  const changed = archive.slice()
  let replacement: number | undefined
  for (let index = 0; index <= changed.byteLength - 30; index += 1) {
    const view = new DataView(changed.buffer, changed.byteOffset + index)
    if (changed[index] === 0x50 && changed[index + 1] === 0x4b
      && changed[index + 2] === 0x03 && changed[index + 3] === 0x04) {
      replacement = view.getUint32(14, true) ^ 0xff
      view.setUint32(14, replacement, true)
    }
    if (changed[index] === 0x50 && changed[index + 1] === 0x4b
      && changed[index + 2] === 0x01 && changed[index + 3] === 0x02 && replacement !== undefined) {
      view.setUint32(16, replacement, true)
      return changed
    }
  }
  throw new Error('test ZIP has no matching local and central headers')
}

const streamingZip = (contents: Uint8Array): Promise<Uint8Array> => new Promise((resolve, reject) => {
  const chunks: Uint8Array[] = []
  const archive = new Zip((error, chunk, final) => {
    if (error !== null) {
      reject(error)
      return
    }
    chunks.push(chunk)
    if (!final) return
    const result = new Uint8Array(chunks.reduce((total, value) => total + value.byteLength, 0))
    let offset = 0
    for (const value of chunks) {
      result.set(value, offset)
      offset += value.byteLength
    }
    resolve(result)
  })
  const entry = new ZipDeflate('SKILL.md')
  archive.add(entry)
  entry.push(contents, true)
  archive.end()
})

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
  options: {
    baseUrl?: string
    now?: () => Date
    config?: Partial<ConstructorParameters<typeof SkillMarketplace>[1]>
    sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  } = {},
): { marketplace: SkillMarketplace; context: Context; fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>> } => {
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
  const context = new Context()
  return {
    marketplace: new SkillMarketplace(
      context,
      {
        registryInstanceId: 'public-skillhub',
        baseUrl: options.baseUrl ?? 'https://skills.example.test',
        ...options.config,
      },
      {
        fetch,
        now: options.now ?? (() => new Date('2026-08-25T09:00:00Z')),
        sleep: options.sleep ?? (() => Promise.resolve()),
      },
    ),
    context,
    fetch,
  }
}

describe('SkillMarketplace.list', () => {
  it('serves list calls through the Cordis service proxy', async () => {
    const { context } = marketplaceFor(await responseBodies())

    await expect(context.skillMarketplace.list({ pageSize: 1 })).resolves.toMatchObject({
      items: [{ title: 'weather' }],
      freshness: 'fresh',
    })
  })

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
      freshness: 'fresh',
      lastSuccessfulAt: '2026-08-25T09:00:00.000Z',
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

    const page = await marketplace.list({ query: 'weather', label: 'utility', sort: 'newest', page: 0, pageSize: 1 })

    expect(inputUrl(fetch.mock.calls[0]![0])).toBe(
      'https://skills.example.test/api/web/skills?page=0&size=1&q=weather&label=utility&sort=newest',
    )
    expect(page.labels).toEqual([{ slug: 'utility', title: 'Utility' }])
    expect(page.items[0]).toMatchObject({ labels: ['utility'], isNew: false })
    expect(page.items[0]).not.toHaveProperty('publishedAt')
  })

  it('serves fresh and stale entries by the complete query key, then reports typed unavailable', async () => {
    const bodies = await responseBodies()
    let clock = new Date('2026-08-25T09:00:00Z')
    const { marketplace, fetch } = marketplaceFor(bodies, {
      now: () => clock,
      config: { freshTtlMs: 300_000, staleTtlMs: 86_400_000 },
    })

    const first = await marketplace.list({ query: 'weather', label: 'utility', sort: 'newest', page: 0, pageSize: 1 })
    clock = new Date('2026-08-25T09:04:59Z')
    const fresh = await marketplace.list({ query: 'weather', label: 'utility', sort: 'newest', page: 0, pageSize: 1 })
    expect(fresh).toEqual(first)
    expect(fetch).toHaveBeenCalledTimes(4)

    clock = new Date('2026-08-25T09:05:01Z')
    fetch.mockRejectedValue(new Error('offline'))
    await expect(marketplace.list({ query: 'weather', label: 'utility', sort: 'newest', page: 0, pageSize: 1 })).resolves.toMatchObject({
      freshness: 'stale',
      lastSuccessfulAt: '2026-08-25T09:00:00.000Z',
    })

    clock = new Date('2026-08-26T09:00:01Z')
    await expect(marketplace.list({ query: 'weather', label: 'utility', sort: 'newest', page: 0, pageSize: 1 })).rejects.toMatchObject({
      code: 'SKILL_MARKETPLACE_UNAVAILABLE',
    })
  })

  it('keeps the newest same-key response in the cache when requests finish out of order', async () => {
    const bodies = await responseBodies()
    const olderPage = structuredClone(bodies.page) as { data: { items: Array<{ displayName: string }> } }
    const newerPage = structuredClone(bodies.page) as { data: { items: Array<{ displayName: string }> } }
    olderPage.data.items[0]!.displayName = 'Older result'
    newerPage.data.items[0]!.displayName = 'Newer result'
    let resolveOlder!: (response: Response) => void
    let resolveNewer!: (response: Response) => void
    let listCall = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(inputUrl(input)).pathname
      if (path === '/api/web/skills') {
        listCall += 1
        return new Promise<Response>((resolve) => {
          if (listCall === 1) resolveOlder = resolve
          else resolveNewer = resolve
        })
      }
      const body = path === '/api/web/labels'
        ? bodies.labels
        : path === '/api/web/skills/global/weather'
          ? bodies.detail
          : bodies.version
      return Response.json(body)
    })
    const marketplace = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test' },
      { fetch, now: () => new Date('2026-08-25T09:00:00Z') },
    )

    const older = marketplace.list({ query: 'weather', pageSize: 1 })
    const newer = marketplace.list({ query: 'weather', pageSize: 1 })
    resolveNewer(Response.json(newerPage))
    await expect(newer).resolves.toMatchObject({ items: [{ title: 'Newer result' }] })
    resolveOlder(Response.json(olderPage))
    await expect(older).resolves.toMatchObject({ items: [{ title: 'Older result' }] })

    await expect(marketplace.list({ query: 'weather', pageSize: 1 })).resolves.toMatchObject({
      items: [{ title: 'Newer result' }],
    })
    expect(listCall).toBe(2)
  })

  it('retries HTTP 429 with bounded local exponential delays and ignores Retry-After', async () => {
    const bodies = await responseBodies()
    const delays: number[] = []
    const { marketplace, fetch } = marketplaceFor(bodies, {
      config: { rateLimitRetries: 2, rateLimitBackoffMs: 25 },
      sleep: async (milliseconds) => { delays.push(milliseconds) },
    })
    fetch
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '900' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockImplementation(async (input) => {
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

    await expect(marketplace.list({ pageSize: 1 })).resolves.toMatchObject({ freshness: 'fresh' })
    expect(delays).toEqual([25, 50])
  })

  it('stops after the configured 429 retry bound', async () => {
    const bodies = await responseBodies()
    const { marketplace, fetch } = marketplaceFor(bodies, {
      config: { rateLimitRetries: 2, rateLimitBackoffMs: 25 },
    })
    fetch.mockResolvedValue(new Response('{}', { status: 429 }))

    await expect(marketplace.list({ pageSize: 1 })).rejects.toMatchObject({
      code: 'SKILL_MARKETPLACE_UPSTREAM',
    })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('cancels an HTTP response body that will not be consumed', async () => {
    const response = new Response('{}', { status: 503 })
    if (response.body === null) throw new Error('test response body is unavailable')
    const cancel = vi.spyOn(response.body, 'cancel')
    const marketplace = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test' },
      { fetch: vi.fn(async () => response), now: () => new Date('2026-08-25T09:00:00Z') },
    )

    await expect(marketplace.list({ pageSize: 1 })).rejects.toMatchObject({ code: 'SKILL_MARKETPLACE_UPSTREAM' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cancels the default 429 backoff without issuing another request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{}', { status: 429 }))
    const marketplace = new SkillMarketplace(
      new Context(),
      {
        registryInstanceId: 'public-skillhub',
        baseUrl: 'https://skills.example.test',
        rateLimitRetries: 1,
        rateLimitBackoffMs: 60_000,
      },
      { fetch, now: () => new Date('2026-08-25T09:00:00Z') },
    )
    const abort = new AbortController()

    const result = marketplace.list({ pageSize: 1 }, abort.signal)
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(1) })
    abort.abort(new Error('cancelled'))

    await expect(result).rejects.toThrow('cancelled')
    expect(fetch).toHaveBeenCalledTimes(1)
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

describe('SkillMarketplace release detail', () => {
  const identity = {
    registryInstanceId: registryInstanceId('public-skillhub'),
    namespace: 'global',
    slug: 'weather',
    version: '1.0.0',
  }

  const releaseResponses = async (metadata: unknown = {
    name: 'weather-toolkit',
    metadata: { examplePrompt: 'Will it rain in Shenzhen tomorrow?' },
  }): Promise<Map<string, Response>> => {
    const version = JSON.parse(await fixture('version-detail')) as { data: { parsedMetadataJson: string } }
    version.data.parsedMetadataJson = JSON.stringify(metadata)
    return new Map([
      ['/api/web/skills/global/weather', Response.json(JSON.parse(await fixture('skill-detail')) as unknown)],
      ['/api/web/skills/global/weather/versions?page=0&size=20', Response.json({
        code: 0,
        data: {
          items: [{ version: '1.0.0', status: 'PUBLISHED', publishedAt: '2026-08-19T08:57:33.532872Z', downloadAvailable: true }],
          total: 1,
          page: 0,
          size: 20,
        },
      })],
      ['/api/web/skills/global/weather/versions/1.0.0', Response.json(version)],
      ['/api/web/skills/global/weather/versions/1.0.0/files', Response.json({
        code: 0,
        data: [{ filePath: 'SKILL.md', fileSize: 117, contentType: 'text/markdown', sha256: 'abc123' }],
      })],
      ['/api/web/skills/global/weather/versions/1.0.0/file?path=SKILL.md', new Response([
        '# Weather toolkit',
        '',
        '<script>alert("unsafe")</script>',
        '',
        '![remote](https://example.test/tracker.png)',
      ].join('\n'), { headers: { 'content-type': 'text/markdown' } })],
      ['/api/web/skills/global/weather/resolve?version=1.0.0', Response.json({
        code: 0,
        data: {
          skillId: 17,
          namespace: 'global',
          slug: 'weather',
          version: '1.0.0',
          versionId: 17,
          fingerprint: 'sha256:abc123',
          matched: true,
          downloadUrl: '/api/web/skills/global/weather/versions/1.0.0/download',
        },
      })],
    ])
  }

  it('returns dsh-owned exact-release fields and the official install command', async () => {
    const responses = await releaseResponses()
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(inputUrl(input))
      return responses.get(`${url.pathname}${url.search}`) ?? new Response('not found', { status: 404 })
    })
    const marketplace = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test' },
      { fetch, now: () => new Date('2026-08-25T09:00:00Z') },
    )

    const detail = await marketplace.get(identity)
    expect(detail.description).toContain('current weather')
    expect(detail.skillMarkdown).toContain('<script>')
    expect(detail).toEqual({
      identity,
      canonicalName: 'weather-toolkit',
      title: 'weather',
      description: 'Retrieve and summarize current weather and forecasts for locations, rain, temperature, and travel planning using an available web tool or wttr.in over HTTPS.',
      publisher: 'Built-in Skill Publisher',
      starCount: 0,
      downloadCount: 0,
      publishedAt: '2026-08-19T08:57:33.532872Z',
      examplePrompt: 'Will it rain in Shenzhen tomorrow?',
      skillMarkdown: [
        '# Weather toolkit',
        '',
        '<script>alert("unsafe")</script>',
        '',
        '![remote](https://example.test/tracker.png)',
      ].join('\n'),
      versions: [{ version: '1.0.0', publishedAt: '2026-08-19T08:57:33.532872Z', downloadAvailable: true }],
      files: [{ path: 'SKILL.md', size: 117, contentType: 'text/markdown', sha256: 'abc123' }],
      installCommand: 'skillhub install weather --namespace global --version 1.0.0',
    })
  })

  it('omits the example when metadata.examplePrompt is absent', async () => {
    const responses = await releaseResponses({ name: 'weather-toolkit', examplePrompt: 'wrong level' })
    const marketplace = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test' },
      {
        fetch: vi.fn<typeof globalThis.fetch>(async (input) => {
          const url = new URL(inputUrl(input))
          return responses.get(`${url.pathname}${url.search}`) ?? new Response('not found', { status: 404 })
        }),
        now: () => new Date('2026-08-25T09:00:00Z'),
      },
    )

    await expect(marketplace.get(identity)).resolves.not.toHaveProperty('examplePrompt')
  })

  it('loads every version page and rejects unsafe CLI identity tokens', async () => {
    const responses = await releaseResponses()
    responses.set('/api/web/skills/global/weather/versions?page=0&size=1', Response.json({
      code: 0,
      data: {
        items: [{ version: '1.0.0', publishedAt: null, downloadAvailable: true }],
        total: 2,
        page: 0,
        size: 1,
      },
    }))
    responses.set('/api/web/skills/global/weather/versions?page=1&size=1', Response.json({
      code: 0,
      data: {
        items: [{ version: '0.9.0', publishedAt: null, downloadAvailable: true }],
        total: 2,
        page: 1,
        size: 1,
      },
    }))
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(inputUrl(input))
      return responses.get(`${url.pathname}${url.search}`) ?? new Response('not found', { status: 404 })
    })
    const marketplace = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', pageSizeLimit: 1 },
      { fetch, now: () => new Date('2026-08-25T09:00:00Z') },
    )

    await expect(marketplace.get(identity)).resolves.toMatchObject({
      versions: [{ version: '1.0.0' }, { version: '0.9.0' }],
    })
    await expect(marketplace.get({ ...identity, slug: 'weather;curl' })).rejects.toMatchObject({
      code: 'SKILL_MARKETPLACE_INVALID_RESPONSE',
    })
  })

  it.each([
    ['a nonzero first page', { page: 1, total: 1, items: [{ version: '1.0.0', publishedAt: null, downloadAvailable: true }] }],
    ['a short result', { page: 0, total: 2, items: [{ version: '1.0.0', publishedAt: null, downloadAvailable: true }] }],
  ])('rejects version pagination with %s', async (_name, changed) => {
    const responses = await releaseResponses()
    responses.set('/api/web/skills/global/weather/versions?page=0&size=20', Response.json({
      code: 0,
      data: { ...changed, size: 20 },
    }))
    const marketplace = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test' },
      {
        fetch: vi.fn<typeof globalThis.fetch>(async (input) => {
          const url = new URL(inputUrl(input))
          return responses.get(`${url.pathname}${url.search}`) ?? new Response('not found', { status: 404 })
        }),
        now: () => new Date('2026-08-25T09:00:00Z'),
      },
    )

    await expect(marketplace.get(identity)).rejects.toMatchObject({ code: 'SKILL_MARKETPLACE_INVALID_RESPONSE' })
  })

  it('rejects a version list beyond the configured total limit before requesting another page', async () => {
    const responses = await releaseResponses()
    responses.set('/api/web/skills/global/weather/versions?page=0&size=1', Response.json({
      code: 0,
      data: {
        items: [{ version: '1.0.0', publishedAt: null, downloadAvailable: true }],
        total: 3,
        page: 0,
        size: 1,
      },
    }))
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(inputUrl(input))
      return responses.get(`${url.pathname}${url.search}`) ?? new Response('not found', { status: 404 })
    })
    const marketplace = new SkillMarketplace(
      new Context(),
      {
        registryInstanceId: 'public-skillhub',
        baseUrl: 'https://skills.example.test',
        pageSizeLimit: 1,
        versionCountLimit: 2,
      },
      { fetch, now: () => new Date('2026-08-25T09:00:00Z') },
    )

    await expect(marketplace.get(identity)).rejects.toMatchObject({ code: 'SKILL_MARKETPLACE_INVALID_RESPONSE' })
    expect(fetch.mock.calls.some(([input]) => inputUrl(input).includes('versions?page=1'))).toBe(false)
  })

  it('rejects repeated versions across otherwise consistent pages', async () => {
    const responses = await releaseResponses()
    for (const page of [0, 1]) {
      responses.set(`/api/web/skills/global/weather/versions?page=${page}&size=1`, Response.json({
        code: 0,
        data: {
          items: [{ version: '1.0.0', publishedAt: null, downloadAvailable: true }],
          total: 2,
          page,
          size: 1,
        },
      }))
    }
    const marketplace = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', pageSizeLimit: 1 },
      {
        fetch: vi.fn<typeof globalThis.fetch>(async (input) => {
          const url = new URL(inputUrl(input))
          return responses.get(`${url.pathname}${url.search}`) ?? new Response('not found', { status: 404 })
        }),
        now: () => new Date('2026-08-25T09:00:00Z'),
      },
    )

    await expect(marketplace.get(identity)).rejects.toMatchObject({ code: 'SKILL_MARKETPLACE_INVALID_RESPONSE' })
  })

  it('bounds SKILL.md by UTF-8 bytes before returning it', async () => {
    const responses = await releaseResponses()
    responses.set(
      '/api/web/skills/global/weather/versions/1.0.0/file?path=SKILL.md',
      new Response(new TextEncoder().encode('天气')),
    )
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(inputUrl(input))
      return responses.get(`${url.pathname}${url.search}`) ?? new Response('not found', { status: 404 })
    })
    const accepted = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', skillMarkdownMaxBytes: 6 },
      { fetch, now: () => new Date('2026-08-25T09:00:00Z') },
    )
    await expect(accepted.get(identity)).resolves.toMatchObject({ skillMarkdown: '天气' })

    const rejectedResponses = await releaseResponses()
    rejectedResponses.set(
      '/api/web/skills/global/weather/versions/1.0.0/file?path=SKILL.md',
      new Response(new TextEncoder().encode('天气')),
    )
    const rejected = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', skillMarkdownMaxBytes: 5 },
      {
        fetch: vi.fn<typeof globalThis.fetch>(async (input) => {
          const url = new URL(inputUrl(input))
          return rejectedResponses.get(`${url.pathname}${url.search}`) ?? new Response('not found', { status: 404 })
        }),
        now: () => new Date('2026-08-25T09:00:00Z'),
      },
    )
    await expect(rejected.get(identity)).rejects.toMatchObject({ code: 'SKILL_MARKETPLACE_INVALID_RESPONSE' })
  })

  it('cancels SKILL.md when its declared length is malformed', async () => {
    const responses = await releaseResponses()
    let cancelled = false
    responses.set(
      '/api/web/skills/global/weather/versions/1.0.0/file?path=SKILL.md',
      new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array([1])) },
        cancel() { cancelled = true },
      }), { headers: { 'content-length': 'invalid' } }),
    )
    const marketplace = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test' },
      {
        fetch: vi.fn<typeof globalThis.fetch>(async (input) => {
          const url = new URL(inputUrl(input))
          return responses.get(`${url.pathname}${url.search}`) ?? new Response('not found', { status: 404 })
        }),
        now: () => new Date('2026-08-25T09:00:00Z'),
      },
    )

    await expect(marketplace.get(identity)).rejects.toMatchObject({ code: 'SKILL_MARKETPLACE_INVALID_RESPONSE' })
    expect(cancelled).toBe(true)
  })

  it('verifies resolve identity and streams the exact artifact without installing it', async () => {
    const responses = await releaseResponses()
    const skillBytes = strToU8('# Weather toolkit\n')
    const zipBytes = zipSync({ 'SKILL.md': skillBytes })
    responses.set('/api/web/skills/global/weather/versions/1.0.0/files', Response.json({
      code: 0,
      data: [{
        filePath: 'SKILL.md',
        fileSize: skillBytes.byteLength,
        contentType: 'text/markdown',
        sha256: createHash('sha256').update(skillBytes).digest('hex'),
      }],
    }))
    responses.set(
      '/api/web/skills/global/weather/versions/1.0.0/download',
      new Response(zipBytes, { headers: { 'content-type': 'application/zip', 'content-length': String(zipBytes.byteLength) } }),
    )
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(inputUrl(input))
      return responses.get(`${url.pathname}${url.search}`) ?? new Response('not found', { status: 404 })
    })
    const marketplace = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test' },
      { fetch, now: () => new Date('2026-08-25T09:00:00Z') },
    )

    const artifact = await marketplace.download(identity)
    expect(artifact).toMatchObject({
      filename: 'weather-toolkit-1.0.0.zip',
      contentType: 'application/zip',
      contentLength: zipBytes.byteLength,
    })
    await expect(new Response(artifact.body).bytes()).resolves.toEqual(zipBytes)
    expect(fetch.mock.calls.map(([input]) => inputUrl(input))).toContain(
      'https://skills.example.test/api/web/skills/global/weather/versions/1.0.0/download',
    )
  })

  it.each<[string, Uint8Array | Promise<Uint8Array>]>([
    ['a non-ZIP body', new TextEncoder().encode('<html>error</html>')],
    ['a structurally invalid ZIP body', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x62, 0x79, 0x74, 0x65, 0x73])],
    ['a ZIP without its central directory', zipSync({ 'SKILL.md': strToU8('# Weather toolkit\n') }).subarray(0, -22)],
    ['a ZIP whose central directory renames a verified file', changedCentralName(zipSync({ 'SKILL.md': strToU8('# Weather toolkit\n') }))],
    ['a ZIP with a Unicode Path override', zipSync({
      'SKILL.md': [strToU8('# Weather toolkit\n'), { extra: { 0x7075: strToU8('override.md') } }],
    })],
    ['a ZIP whose central CRC differs from its local header', changedCentralCrc(zipSync({
      'SKILL.md': strToU8('# Weather toolkit\n'),
    }))],
    ['a ZIP whose local and central CRCs differ from decoded bytes', changedAllCrcs(zipSync({
      'SKILL.md': strToU8('# Weather toolkit\n'),
    }))],
    ['a data-descriptor ZIP whose central CRC differs from decoded bytes', streamingZip(strToU8('# Weather toolkit\n')).then(changedCentralCrc)],
    ['a file with the wrong digest', zipSync({ 'SKILL.md': strToU8('changed') })],
    ['an unexpected file', zipSync({ 'SKILL.md': strToU8('# Weather toolkit\n'), 'extra.txt': strToU8('extra') })],
  ])('rejects %s while consuming the artifact stream', async (_name, zipBytes) => {
    const archive = await zipBytes
    const responses = await releaseResponses()
    const expected = strToU8('# Weather toolkit\n')
    responses.set('/api/web/skills/global/weather/versions/1.0.0/files', Response.json({
      code: 0,
      data: [{
        filePath: 'SKILL.md',
        fileSize: expected.byteLength,
        contentType: 'text/markdown',
        sha256: createHash('sha256').update(expected).digest('hex'),
      }],
    }))
    responses.set(
      '/api/web/skills/global/weather/versions/1.0.0/download',
      new Response(Uint8Array.from(archive), { headers: { 'content-type': 'application/zip' } }),
    )
    const marketplace = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test' },
      {
        fetch: vi.fn<typeof globalThis.fetch>(async (input) => {
          const url = new URL(inputUrl(input))
          return responses.get(`${url.pathname}${url.search}`) ?? new Response('not found', { status: 404 })
        }),
        now: () => new Date('2026-08-25T09:00:00Z'),
      },
    )

    const artifact = await marketplace.download(identity)
    await expect(new Response(artifact.body).bytes()).rejects.toMatchObject({ code: 'SKILL_MARKETPLACE_INVALID_RESPONSE' })
  })

  it('rejects a blank canonical release name', async () => {
    const responses = await releaseResponses({ name: '   ' })
    const marketplace = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test' },
      {
        fetch: vi.fn<typeof globalThis.fetch>(async (input) => {
          const url = new URL(inputUrl(input))
          return responses.get(`${url.pathname}${url.search}`) ?? new Response('not found', { status: 404 })
        }),
        now: () => new Date('2026-08-25T09:00:00Z'),
      },
    )

    await expect(marketplace.get(identity)).rejects.toMatchObject({ code: 'SKILL_MARKETPLACE_INVALID_RESPONSE' })
  })

  it('rejects another Registry Instance or a resolve result for another release', async () => {
    const responses = await releaseResponses()
    responses.set('/api/web/skills/global/weather/resolve?version=1.0.0', Response.json({
      code: 0,
      data: {
        namespace: 'global', slug: 'other', version: '1.0.0', matched: true,
        downloadUrl: '/api/web/skills/global/other/versions/1.0.0/download',
      },
    }))
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(inputUrl(input))
      return responses.get(`${url.pathname}${url.search}`) ?? new Response('not found', { status: 404 })
    })
    const marketplace = new SkillMarketplace(
      new Context(),
      { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test' },
      { fetch, now: () => new Date('2026-08-25T09:00:00Z') },
    )

    await expect(marketplace.get({ ...identity, registryInstanceId: registryInstanceId('other') })).rejects.toBeInstanceOf(RangeError)
    expect(fetch).not.toHaveBeenCalled()
    await expect(marketplace.get(identity)).rejects.toMatchObject({ code: 'SKILL_MARKETPLACE_INVALID_RESPONSE' })
  })
})

describe('SkillMarketplace configuration', () => {
  it('allows an unused backoff beyond the timer range when retries are disabled', () => {
    expect(() => new SkillMarketplace(new Context(), {
      registryInstanceId: 'public-skillhub',
      baseUrl: 'https://skills.example.test',
      rateLimitRetries: 0,
      rateLimitBackoffMs: Number.MAX_SAFE_INTEGER,
    })).not.toThrow()
  })

  it.each([
    ['an empty Registry Instance id', { registryInstanceId: ' ', baseUrl: 'https://skills.example.test' }],
    ['a non-HTTP URL', { registryInstanceId: 'public-skillhub', baseUrl: 'ftp://skills.example.test' }],
    ['a URL username', { registryInstanceId: 'public-skillhub', baseUrl: 'https://user@skills.example.test' }],
    ['a URL password', { registryInstanceId: 'public-skillhub', baseUrl: 'https://:secret@skills.example.test' }],
    ['a zero page limit', { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', pageSizeLimit: 0 }],
    ['a fractional page limit', { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', pageSizeLimit: 1.5 }],
    ['a negative fresh TTL', { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', freshTtlMs: -1 }],
    ['a stale TTL below the fresh TTL', { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', freshTtlMs: 2, staleTtlMs: 1 }],
    ['an unsafe stale TTL', { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', staleTtlMs: Number.MAX_SAFE_INTEGER + 1 }],
    ['a negative retry count', { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', rateLimitRetries: -1 }],
    ['a fractional retry count', { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', rateLimitRetries: 1.5 }],
    ['an excessive retry count', { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', rateLimitRetries: 11 }],
    ['a negative backoff', { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', rateLimitBackoffMs: -1 }],
    ['a fractional backoff', { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', rateLimitBackoffMs: 1.5 }],
    ['a zero SKILL.md byte limit', { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', skillMarkdownMaxBytes: 0 }],
    ['a zero version count limit', { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', versionCountLimit: 0 }],
    ['a zero ZIP directory byte limit', { registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', zipDirectoryMaxBytes: 0 }],
    ['a backoff schedule beyond the timer range', {
      registryInstanceId: 'public-skillhub', baseUrl: 'https://skills.example.test', rateLimitRetries: 10, rateLimitBackoffMs: 5_000_000,
    }],
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
