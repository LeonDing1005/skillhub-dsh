// @vitest-environment jsdom
/** Deterministic Community Skills catalog states and card projection. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommunitySkillListValue, ManagedSkillInstallationEntry, SkillInventoryEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { SkillCenterPage } from '../src/client/SkillCenterPage.tsx'
import { en } from '../src/client/locales.ts'

const t = (key: keyof typeof en): string => en[key]

const page: CommunitySkillListValue = {
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
  freshness: 'fresh',
}

const detail = {
  registryInstanceId: 'public-main',
  namespace: 'global',
  slug: 'weather',
  version: '1.0.0',
  canonicalName: 'weather-toolkit',
  title: 'Weather',
  description: 'Current weather forecasts.',
  publisher: 'Built-in Skill Publisher',
  starCount: 13,
  downloadCount: 341,
  examplePrompt: 'Will it rain tomorrow?',
  skillMarkdown: '# Weather\n\n<script>alert("unsafe")</script>\n\n![remote](https://example.test/tracker.png)\n\n```text\nforecast\n```',
  versions: [{ version: '1.0.0', downloadAvailable: true }],
  files: [{ path: 'SKILL.md', size: 10, contentType: 'text/markdown', sha256: 'abc' }],
  installCommand: 'skillhub install weather --namespace global --version 1.0.0',
} as const

const managed: ManagedSkillInstallationEntry = {
  registryInstanceId: 'public-main',
  namespace: 'global',
  slug: 'weather',
  version: '1.0.0',
  canonicalName: 'weather-toolkit',
  enabled: true,
  installedAt: '2026-08-26T01:00:00.000Z',
  fingerprint: 'sha256:abc',
}

const inventory: SkillInventoryEntry[] = [
  {
    name: 'weather-toolkit', canonicalName: 'weather-toolkit', title: 'Weather Toolkit', description: 'Forecasts for a workspace.', publisher: 'Community Publisher',
    source: 'managed', provider: 'managed', invocation: { modelInvocable: true, userInvocable: true }, managed: true,
    enabled: true, installed: true, resolved: true, resolvedSource: 'managed', readOnly: false,
    registryInstanceId: 'public-main', namespace: 'global', slug: 'weather', version: '1.0.0',
  },
  {
    name: 'local-helper', canonicalName: 'local-helper', title: 'Local Helper', description: 'Use for local work.', publisher: 'custom', source: 'custom', provider: 'filesystem',
    invocation: { modelInvocable: true, userInvocable: true }, managed: false, enabled: true, installed: false, resolved: false,
    resolvedPath: 'custom/local-helper/SKILL.md', readOnly: true,
  },
]

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

  it('loads My Skills and performs disable and uninstall actions', async () => {
    const setEnabled = vi.fn().mockResolvedValue({ ...managed, enabled: false })
    const uninstall = vi.fn().mockResolvedValue({ removed: true })
    render(
      <SkillCenterPage
        load={() => Promise.resolve(page)}
        loadInstallations={() => Promise.resolve({ items: [managed] })}
        setEnabled={setEnabled}
        uninstall={uninstall}
        t={t}
      />,
    )
    await screen.findByRole('heading', { name: 'Weather' })
    fireEvent.click(screen.getByRole('tab', { name: 'My Skills' }))
    expect(await screen.findByRole('heading', { name: 'weather-toolkit' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    await waitFor(() => { expect(setEnabled).toHaveBeenCalledWith({
      registryInstanceId: 'public-main', namespace: 'global', slug: 'weather', version: '1.0.0',
    }, false) })
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }))
    await waitFor(() => { expect(uninstall).toHaveBeenCalledWith({
      registryInstanceId: 'public-main', namespace: 'global', slug: 'weather', version: '1.0.0',
    }) })
  })

  it('renders the complete inventory and filters by publisher, source, and installed state', async () => {
    render(
      <SkillCenterPage
        load={() => Promise.resolve(page)}
        loadInstallations={() => Promise.resolve({ items: [managed] })}
        loadInventory={() => Promise.resolve({ items: inventory })}
        setEnabled={() => Promise.resolve(managed)}
        uninstall={() => Promise.resolve({ removed: true })}
        t={t}
      />,
    )
    await screen.findByRole('heading', { name: 'Weather' })
    fireEvent.click(screen.getByRole('tab', { name: 'My Skills' }))
    expect(await screen.findByRole('heading', { name: 'Weather Toolkit' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Local Helper' })).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search My Skills' }), { target: { value: 'publisher' } })
    expect(await screen.findByRole('heading', { name: 'Weather Toolkit' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Local Helper' })).toBeNull()
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter My Skills' }), { target: { value: 'installed' } })
    expect(screen.getByRole('heading', { name: 'Weather Toolkit' })).toBeTruthy()
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

  it('debounces Host search and combines it with label, sort, and reset pagination', async () => {
    vi.useFakeTimers()
    try {
      const load = vi.fn().mockResolvedValue(page)
      render(<SkillCenterPage load={load} t={t} />)
      await act(async () => { await Promise.resolve() })

      fireEvent.change(screen.getByRole('searchbox', { name: 'Search Community Skills' }), { target: { value: 'weather' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(299) })
      expect(load).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(load).toHaveBeenLastCalledWith(
        { query: 'weather', sort: 'newest', page: 0, pageSize: 12 },
        expect.any(AbortSignal),
      )

      fireEvent.click(screen.getByRole('button', { name: 'Utilities' }))
      fireEvent.change(screen.getByRole('combobox', { name: 'Sort Community Skills' }), { target: { value: 'downloads' } })
      await act(async () => { await Promise.resolve() })
      expect(load).toHaveBeenLastCalledWith(
        { query: 'weather', label: 'utilities', sort: 'downloads', page: 0, pageSize: 12 },
        expect.any(AbortSignal),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps rendered cards stable when the next page fails and lets the user retry it', async () => {
    let rejectNext!: (reason: Error) => void
    const next = new Promise<typeof page>((_resolve, reject) => { rejectNext = reject })
    const load = vi.fn()
      .mockResolvedValueOnce({ ...page, total: 13 })
      .mockReturnValueOnce(next)
      .mockResolvedValueOnce({
        ...page,
        page: 1,
        items: [{ ...page.items[0], slug: 'forecast', title: 'Forecast' }],
        total: 13,
      })
    render(<SkillCenterPage load={load} t={t} />)
    await screen.findByRole('heading', { name: 'Weather' })

    screen.getByRole('button', { name: 'Load more' }).click()
    expect(screen.getByRole('heading', { name: 'Weather' })).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Loading more' })).toBeTruthy()
    rejectNext(new Error('page failed'))
    expect(await screen.findByText('Could not load the next page')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Weather' })).toBeTruthy()

    screen.getByRole('button', { name: 'Retry next page' }).click()
    expect(await screen.findByRole('heading', { name: 'Forecast' })).toBeTruthy()
    expect(screen.getAllByRole('article')).toHaveLength(2)
  })

  it('aborts an in-flight next page when the Skill Center unmounts', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ ...page, total: 2 })
      .mockImplementationOnce((_request, signal: AbortSignal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('aborted', { cause: signal.reason })) }, { once: true })
      }))
    const view = render(<SkillCenterPage load={load} t={t} />)
    await screen.findByRole('heading', { name: 'Weather' })
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })
    const signal = load.mock.calls[1]![1] as AbortSignal

    view.unmount()

    expect(signal.aborted).toBe(true)
  })

  it('aborts the previous query and ignores its late success', async () => {
    vi.useFakeTimers()
    try {
      let resolveFirst!: (value: typeof page) => void
      let resolveSecond!: (value: typeof page) => void
      const first = new Promise<typeof page>((resolve) => { resolveFirst = resolve })
      const second = new Promise<typeof page>((resolve) => { resolveSecond = resolve })
      const load = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
      render(<SkillCenterPage load={load} t={t} />)
      const firstSignal = load.mock.calls[0]![1] as AbortSignal

      fireEvent.change(screen.getByRole('searchbox', { name: 'Search Community Skills' }), { target: { value: 'forecast' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      expect(firstSignal.aborted).toBe(true)

      resolveSecond({ ...page, items: [{ ...page.items[0]!, slug: 'forecast', title: 'Forecast' }] })
      await act(async () => { await second })
      resolveFirst(page)
      await act(async () => { await first })
      expect(screen.getByRole('heading', { name: 'Forecast' })).toBeTruthy()
      expect(screen.queryByRole('heading', { name: 'Weather' })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows stale age and retries without removing cached cards', async () => {
    let resolveRetry!: (value: typeof page) => void
    const retry = new Promise<typeof page>((resolve) => { resolveRetry = resolve })
    const load = vi.fn()
      .mockResolvedValueOnce({ ...page, freshness: 'stale', lastSuccessfulAt: '2026-08-25T09:00:00.000Z' })
      .mockReturnValueOnce(retry)
    render(<SkillCenterPage load={load} t={t} />)

    expect(await screen.findByText(/Last successful refresh: 2026-08-25T09:00:00.000Z/)).toBeTruthy()
    screen.getByRole('button', { name: 'Retry' }).click()
    expect(screen.getByRole('heading', { name: 'Weather' })).toBeTruthy()
    resolveRetry(page)
    await act(async () => { await retry })
    expect(screen.queryByText(/Last successful refresh:/)).toBeNull()
  })

  it('replaces expired stale cards with typed unavailable', async () => {
    const unavailable = Object.assign(new Error('expired'), { code: 'skill-marketplace-unavailable' })
    const load = vi.fn()
      .mockResolvedValueOnce({ ...page, freshness: 'stale', lastSuccessfulAt: '2026-08-25T09:00:00.000Z' })
      .mockRejectedValueOnce(unavailable)
    render(<SkillCenterPage load={load} t={t} />)
    await screen.findByRole('heading', { name: 'Weather' })

    screen.getByRole('button', { name: 'Retry' }).click()

    expect(await screen.findByText('Community Skills unavailable')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Weather' })).toBeNull()
  })

  it('shows only All when the Registry Instance exposes no labels', async () => {
    render(<SkillCenterPage load={() => Promise.resolve({ ...page, labels: [] })} t={t} />)
    await screen.findByRole('heading', { name: 'Weather' })

    expect(screen.getAllByRole('button', { name: 'All' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Utilities' })).toBeNull()
  })

  it('inspects an exact release safely, switches modes, copies, downloads, traps focus, and restores it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const loadDetail = vi.fn().mockResolvedValue(detail)
    const download = vi.fn().mockResolvedValue(undefined)
    render(<SkillCenterPage load={() => Promise.resolve(page)} loadDetail={loadDetail} download={download} t={t} />)
    await screen.findByRole('heading', { name: 'Weather' })
    const opener = screen.getByRole('button', { name: 'View details for Weather' })

    fireEvent.click(opener)
    const dialog = await screen.findByRole('dialog', { name: 'weather-toolkit' })
    expect(dialog.textContent).toContain('Built-in Skill Publisher')
    expect(dialog.textContent).toContain('v1.0.0')
    expect(dialog.textContent).toContain('13 stars')
    expect(dialog.textContent).toContain('341 downloads')
    expect(dialog.textContent).not.toMatch(/views/i)
    expect(dialog.textContent).toContain('Will it rain tomorrow?')
    expect(dialog.textContent).toContain('<script>alert("unsafe")</script>')
    expect(dialog.querySelector('img')).toBeNull()
    expect(await screen.findByRole('button', { name: 'Copy' })).toBeTruthy()

    const close = screen.getByRole('button', { name: 'Close skill details' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Download locally' }))

    fireEvent.click(screen.getByRole('button', { name: 'Local / third-party installation' }))
    expect(screen.getByText(detail.installCommand)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copy install command' }))
    expect(await screen.findByText('Copied')).toBeTruthy()
    expect(writeText).toHaveBeenCalledWith(detail.installCommand)

    fireEvent.click(screen.getByRole('button', { name: 'Download locally' }))
    await waitFor(() => {
      expect(download).toHaveBeenCalledWith({
        registryInstanceId: 'public-main', namespace: 'global', slug: 'weather', version: '1.0.0',
      })
    })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(document.activeElement).toBe(opener)
  })

  it('omits the example section when metadata.examplePrompt was absent', async () => {
    const { examplePrompt: _examplePrompt, ...withoutExample } = detail
    render(
      <SkillCenterPage
        load={() => Promise.resolve(page)}
        loadDetail={() => Promise.resolve(withoutExample)}
        download={() => Promise.resolve()}
        t={t}
      />,
    )
    await screen.findByRole('heading', { name: 'Weather' })
    fireEvent.click(screen.getByRole('button', { name: 'View details for Weather' }))
    await screen.findByRole('dialog', { name: 'weather-toolkit' })

    expect(screen.queryByRole('heading', { name: 'Example prompt' })).toBeNull()
  })

  it('installs a Community Skill from the exact-release dialog', async () => {
    const install = vi.fn().mockResolvedValue(managed)
    render(
      <SkillCenterPage
        load={() => Promise.resolve(page)}
        loadDetail={() => Promise.resolve(detail)}
        download={() => Promise.resolve()}
        install={install}
        t={t}
      />,
    )
    await screen.findByRole('heading', { name: 'Weather' })
    fireEvent.click(screen.getByRole('button', { name: 'View details for Weather' }))
    await screen.findByRole('dialog', { name: 'weather-toolkit' })
    fireEvent.click(screen.getByRole('button', { name: 'Install to My Skills' }))
    expect(install).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => { expect(install).toHaveBeenCalledWith({
      registryInstanceId: 'public-main', namespace: 'global', slug: 'weather', version: '1.0.0',
    }) })
  })

  it('returns to the conversation and inserts an enabled managed skill token', async () => {
    const useInConversation = vi.fn()
    render(
      <SkillCenterPage
        load={() => Promise.resolve(page)}
        loadDetail={() => Promise.resolve(detail)}
        download={() => Promise.resolve()}
        loadInstallations={() => Promise.resolve({ items: [managed] })}
        setEnabled={() => Promise.resolve(managed)}
        uninstall={() => Promise.resolve({ removed: true })}
        useInConversation={useInConversation}
        t={t}
      />,
    )
    await screen.findByRole('heading', { name: 'Weather' })
    fireEvent.click(screen.getByRole('button', { name: 'View details for Weather' }))
    await screen.findByRole('dialog', { name: 'weather-toolkit' })
    fireEvent.click(screen.getByRole('button', { name: 'Use in conversation' }))
    expect(useInConversation).toHaveBeenCalledWith('weather-toolkit')
  })
})
