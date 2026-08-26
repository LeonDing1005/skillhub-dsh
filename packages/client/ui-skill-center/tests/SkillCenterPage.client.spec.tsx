// @vitest-environment jsdom
/** Deterministic Community Skills catalog states and card projection. */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillCenterPage } from '../src/client/SkillCenterPage.tsx'
import { en } from '../src/client/locales.ts'

const t = (key: keyof typeof en): string => en[key]

const page = {
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
} as const

afterEach(cleanup)

describe('SkillCenterPage', () => {
  it('renders loading while the Community catalog is pending', () => {
    render(<SkillCenterPage load={() => new Promise(() => {})} t={t} />)

    expect(screen.getByRole('status').textContent).toBe('Loading Community Skills')
  })

  it('renders the stable card fields and the two supported metrics', async () => {
    render(<SkillCenterPage load={() => Promise.resolve(page)} t={t} />)

    expect(await screen.findByRole('heading', { name: 'Weather' })).toBeTruthy()
    expect(screen.getByText('Built-in Skill Publisher')).toBeTruthy()
    expect(screen.getByText('global/weather')).toBeTruthy()
    expect(screen.getByText('v1.0.0')).toBeTruthy()
    expect(screen.getByLabelText('12 stars')).toBeTruthy()
    expect(screen.getByLabelText('340 downloads')).toBeTruthy()
    expect(screen.getByText('New')).toBeTruthy()
    expect(screen.queryByText(/views/i)).toBeNull()
  })

  it('renders the empty catalog state', async () => {
    render(<SkillCenterPage load={() => Promise.resolve({ ...page, items: [], total: 0 })} t={t} />)

    expect(await screen.findByText('No Community Skills yet')).toBeTruthy()
  })

  it('renders failure and retries the catalog request', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page)
    render(<SkillCenterPage load={load} t={t} />)

    await screen.findByText('Community Skills unavailable')
    screen.getByRole('button', { name: 'Retry' }).click()

    await waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })
    expect(await screen.findByRole('heading', { name: 'Weather' })).toBeTruthy()
  })

  it('keeps My Skills visible but disabled in the foundation route', () => {
    render(<SkillCenterPage load={() => new Promise(() => {})} t={t} />)

    expect(screen.getByRole('tab', { name: 'Community Skills' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole<HTMLButtonElement>('tab', { name: 'My Skills' }).disabled).toBe(true)
  })

  it.each(['resolve', 'reject'] as const)('ignores a catalog %s after unmount', async (settlement) => {
    let settle!: (value: typeof page) => void
    let fail!: (reason: Error) => void
    const pending = new Promise<typeof page>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    const view = render(<SkillCenterPage load={() => pending} t={t} />)
    view.unmount()

    if (settlement === 'resolve') settle(page)
    else fail(new Error('late failure'))
    await expect(pending.catch(() => page)).resolves.toBe(page)
  })
})
