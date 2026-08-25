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
    })
    ctx.provide('skillMarketplace', { list } as never)

    const response = await api(ctx).skills.communityList(request({ query: 'weather', page: 0, pageSize: 12 }))

    expect(list).toHaveBeenCalledWith({ query: 'weather', page: 0, pageSize: 12 }, undefined)
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
      },
    })
  })

  it('reports a missing marketplace service as a wire failure', async () => {
    const response = await api(new Context()).skills.communityList(request({}))

    expect(response.result).toMatchObject({ ok: false, error: { code: 'internal' } })
  })
})
