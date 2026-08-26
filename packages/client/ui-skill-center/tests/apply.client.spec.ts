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

const emptyPage = { items: [], labels: [], total: 0, page: 0, pageSize: 12 }

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
  const layout = { openPage: vi.fn() }
  const communityList = vi.fn().mockResolvedValue({ result: { ok: true, value: emptyPage } })
  ctx.provide('locale', locale)
  ctx.provide('layout', layout as never)
  ctx.provide('connection', { api: { skills: { communityList } } } as never)
  return { ctx, slots, locale, layout, communityList }
}

describe('ui-skill-center apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'layout', 'locale', 'connection'])
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
    const { load } = (pageEntry.inject as () => {
      load: (signal: AbortSignal) => Promise<typeof emptyPage>
    })()
    const signal = new AbortController().signal

    await expect(load(signal)).resolves.toEqual(emptyPage)
    expect(b.communityList).toHaveBeenCalledWith({ page: 0, pageSize: 12 }, signal)
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

  it('surfaces a failed Community API result to the page loader', async () => {
    const b = await bench()
    b.communityList.mockResolvedValueOnce({
      result: { ok: false, error: { code: 'internal', message: 'catalog unavailable', details: {} } },
    })
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('shell.page')[0]!
    const { load } = (entry.inject as () => { load: (signal: AbortSignal) => Promise<unknown> })()
    await expect(load(new AbortController().signal)).rejects.toThrow('catalog unavailable')
  })
})
