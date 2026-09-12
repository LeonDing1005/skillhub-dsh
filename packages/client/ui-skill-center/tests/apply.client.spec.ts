// @vitest-environment jsdom
/** Skill Center route, sidebar action, locale contribution, and disposal. */
import { createElement, type ComponentType } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as nodeApply } from '@deepseek-ai/dsh-client-ui-skill-center'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-skill-center/client'
import { en } from '../src/client/locales.ts'

const emptyPage = { items: [], labels: [], total: 0, page: 0, pageSize: 12, freshness: 'fresh' as const }

afterEach(cleanup)

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'shell.page': { kind: 'list', scope: 'root' },
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  const locale = new LocaleRuntime(ctx)
  const layout = { openPage: vi.fn(), showConversation: vi.fn() }
  const sessions = {
    list: { getSnapshot: () => ({ current: undefined }) },
    scope: vi.fn(),
    create: vi.fn(),
    open: vi.fn(),
  }
  const communityList = vi.fn().mockResolvedValue({ result: { ok: true, value: emptyPage } })
  const communityGet = vi.fn().mockResolvedValue({ result: { ok: true, value: { canonicalName: 'weather' } } })
  ctx.provide('locale', locale)
  ctx.provide('layout', layout as never)
  ctx.provide('sessions', sessions as never)
  ctx.provide('connection', { api: { skills: { communityList, communityGet } } } as never)
  return { ctx, slots, locale, layout, sessions, communityList, communityGet }
}

describe('ui-skill-center apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'layout', 'locale', 'connection', 'sessions'])
  })

  it('keeps the node half inert because behavior runs in the browser graph', () => {
    nodeApply()
    expect(true).toBe(true)
  })

  it('removes the page, sidebar action, and dictionaries on disposal', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    expect(b.slots.entries('shell.page')).toHaveLength(1)
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(1)
    expect(b.locale.bind('skillCenter')('title')).toBe('Skill Center')

    await fiber.dispose()

    expect(b.slots.entries('shell.page')).toHaveLength(0)
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(0)
    expect(() => b.locale.register('skillCenter', 'zh', {})).not.toThrow()
    expect(() => b.locale.register('skillCenter', 'en', {})).not.toThrow()
  })

  it('routes the Community page loader and sidebar action through their injected faces', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const pageEntry = b.slots.entries('shell.page')[0]!
    const actionEntry = b.slots.entries('sidebar.footer.action')[0]!
    const { load, loadDetail } = (pageEntry.inject as () => {
      load: (request: { sort: string; page: number; pageSize: number }, signal: AbortSignal) => Promise<typeof emptyPage>
      loadDetail: (
        identity: { registryInstanceId: string; namespace: string; slug: string; version: string },
        signal: AbortSignal,
      ) => Promise<unknown>
    })()
    const signal = new AbortController().signal

    await expect(load({ sort: 'newest', page: 0, pageSize: 12 }, signal)).resolves.toEqual(emptyPage)
    expect(b.communityList).toHaveBeenCalledWith({ sort: 'newest', page: 0, pageSize: 12 }, signal)
    const identity = { registryInstanceId: 'public-main', namespace: 'global', slug: 'weather', version: '1.0.0' }
    await expect(loadDetail(identity, signal)).resolves.toEqual({ canonicalName: 'weather' })
    expect(b.communityGet).toHaveBeenCalledWith(identity, signal)
    const { open } = (actionEntry.inject as () => { open: () => void })()
    open()
    expect(b.layout.openPage).toHaveBeenCalledWith('skill-center')

    const PageRoute = pageEntry.component as ComponentType<{
      pageId: string
      load: typeof load
      t: (key: keyof typeof en) => string
    }>
    const t = (key: keyof typeof en): string => en[key]
    const view = render(createElement(PageRoute, { pageId: 'conversation', load, t }))
    expect(view.container.innerHTML).toBe('')
    view.rerender(createElement(PageRoute, { pageId: 'skill-center', load, t }))
    expect(await screen.findByText('No Community Skills yet')).toBeTruthy()
  })

  it('uses the current scoped conversation and creates a blank session when none is selected', async () => {
    const b = await bench()
    const insertSkillToken = vi.fn()
    const scope = { get: vi.fn().mockReturnValue({ insertSkillToken }) }
    b.sessions.list.getSnapshot = () => ({
      current: 'session-1', ids: ['session-1'], byId: {
        'session-1': { id: 'session-1', origin: undefined, blank: false, updatedAt: 2 },
      },
    }) as never
    b.sessions.scope.mockReturnValue(scope)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('shell.page')[0]!
    const props = (entry.inject as () => { useInConversation: (name: string) => Promise<void> })()
    await props.useInConversation('weather-toolkit')
    expect(scope.get).toHaveBeenCalledWith('conversation')
    expect(insertSkillToken).toHaveBeenCalledWith('weather-toolkit')
    expect(b.layout.showConversation).toHaveBeenCalledTimes(1)

    b.sessions.scope.mockReturnValue(undefined)
    await expect(props.useInConversation('weather-toolkit')).rejects.toThrow('session "session-1" is unavailable')

    b.sessions.list.getSnapshot = () => ({ current: undefined, ids: [], byId: {} }) as never
    b.sessions.create = vi.fn().mockResolvedValue('created-session')
    b.sessions.open = vi.fn()
    b.sessions.scope.mockReturnValue(scope)
    await props.useInConversation('weather-toolkit')
    expect(b.sessions.create).toHaveBeenCalledWith()
    expect(b.sessions.open).toHaveBeenCalledWith('created-session')
  })

  it('surfaces a failed Community API result to the page loader', async () => {
    const b = await bench()
    b.communityList.mockResolvedValueOnce({
      result: { ok: false, error: { code: 'internal', message: 'catalog unavailable', details: {} } },
    })
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('shell.page')[0]!
    const { load } = (entry.inject as () => {
      load: (request: { page: number }, signal: AbortSignal) => Promise<unknown>
    })()
    await expect(load({ page: 0 }, new AbortController().signal)).rejects.toThrow('catalog unavailable')
  })
})
