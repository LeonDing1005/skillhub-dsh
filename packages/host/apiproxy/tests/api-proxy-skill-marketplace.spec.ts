/** Community Skills wire projection over the Host marketplace service. */
import { Context } from '@deepseek-ai/cordis'
import { registryInstanceId } from '@deepseek-ai/dsh-skill-marketplace'
import { describe, expect, it, vi } from 'vitest'
import { createApiProxy } from '../src/api-proxy.ts'
import { RpcId, type RpcRequest } from '../src/api/rpc.ts'

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId('community-skills'), payload }
}

function api(ctx: Context) {
  ctx.provide('userQuestions', { registerProvider: () => () => undefined } as never)
  return createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
    cwd: '/tmp',
  })
}

describe('skills.communityList', () => {
  it('projects normalized catalog data without upstream or Host-only fields', async () => {
    const ctx = new Context()
    const list = vi.fn().mockResolvedValue({
      items: [{
        identity: {
          registryInstanceId: registryInstanceId('public-main'),
          namespace: 'global',
          slug: 'weather',
          version: '1.0.0',
        },
        title: 'Weather',
        description: 'Current weather forecasts.',
        publisher: 'Built-in Skill Publisher',
        starCount: 12,
        downloadCount: 340,
        labels: ['utilities'],
        publishedAt: '2026-08-19T08:57:33.532872Z',
        isNew: true,
      }],
      labels: [{ slug: 'utilities', title: 'Utilities' }],
      total: 1,
      page: 0,
      pageSize: 12,
      freshness: 'stale',
      lastSuccessfulAt: '2026-08-25T09:00:00.000Z',
    })
    ctx.provide('skillMarketplace', { list } as never)

    const response = await api(ctx).skills.communityList(request({ query: 'weather', sort: 'newest', page: 0, pageSize: 12 }))

    expect(list).toHaveBeenCalledWith({ query: 'weather', sort: 'newest', page: 0, pageSize: 12 }, undefined)
    expect(response.result).toEqual({
      ok: true,
      value: {
        items: [{
          registryInstanceId: 'public-main',
          namespace: 'global',
          slug: 'weather',
          version: '1.0.0',
          title: 'Weather',
          description: 'Current weather forecasts.',
          publisher: 'Built-in Skill Publisher',
          starCount: 12,
          downloadCount: 340,
          labels: ['utilities'],
          publishedAt: '2026-08-19T08:57:33.532872Z',
          isNew: true,
        }],
        labels: [{ slug: 'utilities', title: 'Utilities' }],
        total: 1,
        page: 0,
        pageSize: 12,
        freshness: 'stale',
        lastSuccessfulAt: '2026-08-25T09:00:00.000Z',
      },
    })
  })

  it('reports a missing marketplace service as a wire failure', async () => {
    const response = await api(new Context()).skills.communityList(request({}))

    expect(response.result).toMatchObject({ ok: false, error: { code: 'internal' } })
  })

  it('maps an exhausted upstream listing to typed unavailable', async () => {
    const ctx = new Context()
    ctx.provide('skillMarketplace', {
      list: vi.fn().mockRejectedValue(Object.assign(new Error('offline'), { code: 'SKILL_MARKETPLACE_UPSTREAM' })),
    } as never)

    const response = await api(ctx).skills.communityList(request({}))

    expect(response.result).toEqual({
      ok: false,
      error: { code: 'skill-marketplace-unavailable', message: 'Community Skills is temporarily unavailable', details: {} },
    })
  })
})

describe('exact Community Skill release', () => {
  const identity = {
    registryInstanceId: 'public-main',
    namespace: 'global',
    slug: 'weather',
    version: '1.0.0',
  }

  it('projects exact detail through RPC without leaking adapter fields', async () => {
    const ctx = new Context()
    const get = vi.fn().mockResolvedValue({
      identity: { ...identity, registryInstanceId: registryInstanceId(identity.registryInstanceId) },
      canonicalName: 'weather-toolkit',
      title: 'Weather',
      description: 'Current weather forecasts.',
      publisher: 'Built-in Skill Publisher',
      starCount: 12,
      downloadCount: 340,
      publishedAt: '2026-08-19T08:57:33.532872Z',
      examplePrompt: 'Will it rain tomorrow?',
      skillMarkdown: '# Weather',
      versions: [{ version: '1.0.0', downloadAvailable: true }],
      files: [{ path: 'SKILL.md', size: 10, contentType: 'text/markdown', sha256: 'abc' }],
      installCommand: 'skillhub install weather --namespace global --version 1.0.0',
    })
    ctx.provide('skillMarketplace', { get } as never)

    const response = await api(ctx).skills.communityGet(request(identity))

    expect(get).toHaveBeenCalledWith({ ...identity, registryInstanceId: registryInstanceId('public-main') }, undefined)
    if (!response.result.ok) throw new Error(`unexpected RPC failure: ${response.result.error.code}`)
    expect(response.result.value).toMatchObject({
      ...identity,
      canonicalName: 'weather-toolkit',
      examplePrompt: 'Will it rain tomorrow?',
      skillMarkdown: '# Weather',
      installCommand: 'skillhub install weather --namespace global --version 1.0.0',
    })
  })

  it('streams a verified exact artifact with an attachment filename', async () => {
    const ctx = new Context()
    const download = vi.fn().mockResolvedValue({
      filename: 'weather-toolkit-1.0.0.zip',
      contentType: 'application/zip',
      contentLength: 9,
      body: new Response('zip bytes').body,
    })
    ctx.provide('skillMarketplace', { download } as never)

    const response = await api(ctx).downloads.communitySkill(identity, new AbortController().signal)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="weather-toolkit-1.0.0.zip"')
    expect(response.headers.get('content-length')).toBe('9')
    await expect(response.text()).resolves.toBe('zip bytes')
  })
})
