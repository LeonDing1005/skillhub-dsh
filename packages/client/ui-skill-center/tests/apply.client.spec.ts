/** Skill Center route, sidebar action, locale contribution, and disposal. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-skill-center/client'

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
  ctx.provide('locale', locale)
  ctx.provide('layout', layout as never)
  ctx.provide('connection', { api: { skills: { communityList: vi.fn() } } } as never)
  return { ctx, slots, locale, layout }
}

describe('ui-skill-center apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'layout', 'locale', 'connection'])
  })

  it('removes the page, sidebar action, and dictionaries on disposal', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    expect(b.slots.entries('shell.page')).toHaveLength(1)
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(1)
    expect(b.locale.bind('skillCenter')('title')).toBe('技能中心')

    await fiber.dispose()

    expect(b.slots.entries('shell.page')).toHaveLength(0)
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(0)
    expect(() => b.locale.register('skillCenter', 'zh', {})).not.toThrow()
    expect(() => b.locale.register('skillCenter', 'en', {})).not.toThrow()
  })
})
