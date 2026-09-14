/** Community Skills discovery with abortable query-keyed pagination and stale recovery. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  IconDownloadOutline16, IconRefreshOutline16, IconSearchOutline16, IconSkillOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { CommunitySkillListPayload, CommunitySkillListValue } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  CommunitySkillDetailValue, CommunitySkillEntry, CommunitySkillIdentityPayload,
  ManagedSkillInstallationEntry, ManagedSkillInstallationListValue,
  SkillInventoryEntry, SkillInventoryListValue,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SkillCenterKey } from './locales.ts'
import { SkillDetailDialog } from './SkillDetailDialog.tsx'
import css from './SkillCenterPage.module.css'

const PAGE_SIZE = 12
const SEARCH_DEBOUNCE_MS = 300
const DEFAULT_SORT = 'newest'

/** Pure page inputs; the slot route supplies the Remote-backed loader. */
export interface SkillCenterPageProps {
  readonly load: (request: CommunitySkillListPayload, signal: AbortSignal) => Promise<CommunitySkillListValue>
  readonly loadDetail?: (identity: CommunitySkillIdentityPayload, signal: AbortSignal) => Promise<CommunitySkillDetailValue>
  readonly download?: (identity: CommunitySkillIdentityPayload) => Promise<void>
  readonly loadInstallations?: (signal: AbortSignal) => Promise<ManagedSkillInstallationListValue>
  readonly loadInventory?: (signal: AbortSignal) => Promise<SkillInventoryListValue>
  readonly subscribeInventory?: (listener: () => void) => () => void
  readonly install?: (identity: CommunitySkillIdentityPayload) => Promise<ManagedSkillInstallationEntry>
  readonly update?: (identity: CommunitySkillIdentityPayload, fromVersion: string) => Promise<ManagedSkillInstallationEntry>
  readonly setEnabled?: (identity: CommunitySkillIdentityPayload, enabled: boolean) => Promise<ManagedSkillInstallationEntry>
  readonly uninstall?: (identity: CommunitySkillIdentityPayload) => Promise<{ removed: boolean }>
  readonly useInConversation?: (name: string) => Promise<void> | void
  readonly t: (key: SkillCenterKey) => string
}

type CatalogState =
  | { readonly status: 'loading' }
  | { readonly status: 'failure' }
  | {
    readonly status: 'ready'
    readonly value: CommunitySkillListValue
    readonly next: 'idle' | 'loading' | 'failure'
    readonly refreshing: boolean
  }

type InstallationState =
  | { readonly status: 'loading' }
  | { readonly status: 'failure' }
  | { readonly status: 'ready'; readonly items: readonly ManagedSkillInstallationEntry[] }

type InventoryState =
  | { readonly status: 'loading' }
  | { readonly status: 'failure' }
  | { readonly status: 'ready'; readonly items: readonly SkillInventoryEntry[] }

/** Render Community Skills discovery and the managed Personal Skill Inventory. */
export function SkillCenterPage({
  load, loadDetail, download, loadInstallations, loadInventory, subscribeInventory,
  install, update, setEnabled, uninstall, useInConversation, t,
}: SkillCenterPageProps) {
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [label, setLabel] = useState('')
  const [sort, setSort] = useState(DEFAULT_SORT)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<CatalogState>({ status: 'loading' })
  const [selected, setSelected] = useState<{ skill: CommunitySkillEntry; opener: HTMLElement }>()
  const [tab, setTab] = useState<'community' | 'mine'>('community')
  const [installations, setInstallations] = useState<InstallationState>({ status: 'loading' })
  const [installationAttempt, setInstallationAttempt] = useState(0)
  const [inventory, setInventory] = useState<InventoryState>({ status: 'loading' })
  const [inventoryAttempt, setInventoryAttempt] = useState(0)
  const [inventorySearch, setInventorySearch] = useState('')
  const [inventoryFilter, setInventoryFilter] = useState<'all' | 'installed'>('all')
  const generation = useRef(0)
  const nextController = useRef<AbortController>()
  const keepCardsForRetry = useRef(false)
  const canManage = loadInstallations !== undefined && setEnabled !== undefined && uninstall !== undefined

  useEffect(() => {
    if (loadInstallations === undefined) return
    const abort = new AbortController()
    setInstallations({ status: 'loading' })
    loadInstallations(abort.signal).then(
      (value) => { if (!abort.signal.aborted) setInstallations({ status: 'ready', items: value.items }) },
      () => { if (!abort.signal.aborted) setInstallations({ status: 'failure' }) },
    )
    return () => { abort.abort() }
  }, [installationAttempt, loadInstallations])

  useEffect(() => {
    if (loadInventory === undefined) return
    const abort = new AbortController()
    setInventory({ status: 'loading' })
    loadInventory(abort.signal).then(
      (value) => { if (!abort.signal.aborted) setInventory({ status: 'ready', items: value.items }) },
      () => { if (!abort.signal.aborted) setInventory({ status: 'failure' }) },
    )
    return () => { abort.abort() }
  }, [inventoryAttempt, loadInventory])

  useEffect(() => subscribeInventory?.(() => { setInventoryAttempt(value => value + 1) }), [subscribeInventory])

  const refreshInstallations = useCallback(() => { setInstallationAttempt(value => value + 1) }, [])

  useEffect(() => {
    const normalized = search.trim()
    if (normalized === query) return
    const timeout = setTimeout(() => { setQuery(normalized) }, SEARCH_DEBOUNCE_MS)
    return () => { clearTimeout(timeout) }
  }, [query, search])

  useEffect(() => {
    const currentGeneration = generation.current + 1
    generation.current = currentGeneration
    nextController.current?.abort()
    const abort = new AbortController()
    const keepCards = keepCardsForRetry.current
    keepCardsForRetry.current = false
    setState(previous => keepCards && previous.status === 'ready'
      ? { ...previous, refreshing: true }
      : { status: 'loading' })
    load(listRequest(query, label, sort, 0), abort.signal).then(
      (value) => {
        if (!abort.signal.aborted && generation.current === currentGeneration) {
          setState({ status: 'ready', value, next: 'idle', refreshing: false })
        }
      },
      (error: unknown) => {
        if (abort.signal.aborted || generation.current !== currentGeneration) return
        if (isMarketplaceUnavailable(error)) {
          setState({ status: 'failure' })
          return
        }
        setState(previous => keepCards && previous.status === 'ready'
          ? { ...previous, refreshing: false }
          : { status: 'failure' })
      },
    )
    return () => {
      abort.abort()
      nextController.current?.abort()
    }
  }, [attempt, label, load, query, sort])

  const retry = useCallback(() => {
    if (state.status === 'ready') keepCardsForRetry.current = true
    setAttempt(value => value + 1)
  }, [state.status])

  const loadNext = useCallback(() => {
    if (state.status !== 'ready' || state.next === 'loading') return
    const currentGeneration = generation.current
    const abort = new AbortController()
    nextController.current?.abort()
    nextController.current = abort
    flushSync(() => { setState({ ...state, next: 'loading' }) })
    load(listRequest(query, label, sort, state.value.page + 1), abort.signal).then(
      (value) => {
        if (abort.signal.aborted || generation.current !== currentGeneration) return
        setState(previous => previous.status === 'ready'
          ? {
            status: 'ready',
            value: { ...value, items: [...previous.value.items, ...value.items] },
            next: 'idle',
            refreshing: false,
          }
          : previous)
      },
      () => {
        if (abort.signal.aborted || generation.current !== currentGeneration) return
        setState(previous => previous.status === 'ready' ? { ...previous, next: 'failure' } : previous)
      },
    )
  }, [label, load, query, sort, state])

  return (
    <main className={css.root} aria-label={t('title')}>
      <header className={css.header}>
        <div className={css.titleRow}>
          <IconSkillOutline16 size={22} />
          <h1>{t('title')}</h1>
        </div>
        <div className={css.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'community'}
            className={tab === 'community' ? css.activeTab : undefined}
            onClick={() => { setTab('community') }}
          >{t('tab.community')}</button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'mine'}
            className={tab === 'mine' ? css.activeTab : undefined}
            disabled={!canManage}
            onClick={() => { setTab('mine') }}
          >{t('tab.mine')}</button>
        </div>
      </header>
      <section className={css.content}>
        {tab === 'mine' && canManage && loadInventory !== undefined && (
          <InventorySkills
            state={inventory}
            search={inventorySearch}
            filter={inventoryFilter}
            onSearch={setInventorySearch}
            onFilter={setInventoryFilter}
            setEnabled={setEnabled}
            uninstall={uninstall}
            onChanged={() => { refreshInstallations(); setInventoryAttempt(value => value + 1) }}
            t={t}
          />
        )}
        {tab === 'mine' && canManage && loadInventory === undefined && (
          <ManagedSkills
            state={installations}
            setEnabled={setEnabled}
            uninstall={uninstall}
            onChanged={refreshInstallations}
            t={t}
          />
        )}
        {tab === 'community' && <>
          <div className={css.discoveryControls}>
            <label className={css.search}>
              <IconSearchOutline16 size={16} />
              <input
                type="search"
                aria-label={t('search.label')}
                placeholder={t('search.placeholder')}
                value={search}
                onChange={(event) => { setSearch(event.currentTarget.value) }}
              />
            </label>
            <select
              className={css.sort}
              aria-label={t('sort.label')}
              value={sort}
              onChange={(event) => { setSort(event.currentTarget.value) }}
            >
              <option value="newest">{t('sort.newest')}</option>
              <option value="downloads">{t('sort.downloads')}</option>
              <option value="stars">{t('sort.stars')}</option>
            </select>
          </div>
          {state.status === 'ready' && (
            <div className={css.categories} aria-label={t('categories')}>
              <button type="button" aria-pressed={label === ''} onClick={() => { setLabel('') }}>{t('all')}</button>
              {state.value.labels.map(item => (
                <button
                  type="button"
                  key={item.slug}
                  aria-pressed={label === item.slug}
                  onClick={() => { setLabel(item.slug) }}
                >
                  {item.title}
                </button>
              ))}
            </div>
          )}
          {state.status === 'loading' && <div className={css.state} role="status">{t('loading')}</div>}
          {state.status === 'failure' && (
            <div className={css.state} role="alert">
              <strong>{t('failure.title')}</strong>
              <RetryButton label={t('retry')} onClick={retry} />
            </div>
          )}
          {state.status === 'ready' && state.value.freshness === 'stale' && (
            <div className={css.stale} role="status">
              <span>{t('stale.prefix')} {state.value.lastSuccessfulAt}</span>
              <RetryButton label={t('retry')} onClick={retry} disabled={state.refreshing} />
            </div>
          )}
          {state.status === 'ready' && state.value.items.length === 0 && <div className={css.state}>{t('empty.title')}</div>}
          {state.status === 'ready' && state.value.items.length > 0 && (
            <>
              <div className={css.grid}>
                {state.value.items.map(skill => (
                  <article key={`${skill.registryInstanceId}:${skill.namespace}/${skill.slug}@${skill.version}`} className={css.card}>
                    {loadDetail !== undefined && download !== undefined && (
                      <button
                        type="button"
                        className={css.cardTarget}
                        aria-label={`${t('detail.open')} ${skill.title}`}
                        onClick={(event) => { setSelected({ skill, opener: event.currentTarget }) }}
                      />
                    )}
                    <div className={css.cardTop}>
                      <div className={css.skillIcon}><IconSkillOutline16 size={20} /></div>
                      {skill.isNew && <span className={css.newBadge}>{t('new')}</span>}
                    </div>
                    <div className={css.identity}>{skill.namespace}/{skill.slug}</div>
                    <h2>{skill.title}</h2>
                    <p className={css.description}>{skill.description}</p>
                    <div className={css.publisher}>{skill.publisher}</div>
                    <div className={css.labels}>{skill.labels.map(item => <span key={item}>{item}</span>)}</div>
                    <footer className={css.cardFooter}>
                      <span className={css.version}>v{skill.version}</span>
                      <span className={css.metrics}>
                        <span aria-label={`${skill.starCount} ${t('stars')}`}>{skill.starCount} {t('stars')}</span>
                        <span aria-label={`${skill.downloadCount} ${t('downloads')}`}><IconDownloadOutline16 size={14} /> {skill.downloadCount}</span>
                      </span>
                    </footer>
                  </article>
                ))}
              </div>
              {state.value.items.length < state.value.total && (
                <div className={css.pagination}>
                  {state.next === 'failure' && <span role="alert">{t('next.failure')}</span>}
                  <button type="button" onClick={loadNext} disabled={state.next === 'loading'}>
                    {state.next === 'loading'
                      ? t('next.loading')
                      : state.next === 'failure' ? t('next.retry') : t('next.load')}
                  </button>
                </div>
              )}
            </>
          )}
        </>}
      </section>
      {selected !== undefined && loadDetail !== undefined && download !== undefined && (
        <SkillDetailDialog
          skill={selected.skill}
          load={loadDetail}
          download={download}
          {...(() => {
            const installation = installations.status === 'ready'
              ? installations.items.find(item => sameIdentity(item, identityFor(selected.skill)))
              : undefined
            return {
              ...(installation === undefined ? {} : { installation }),
              ...(install === undefined ? {} : { install }),
              ...(update === undefined ? {} : { update }),
              ...(setEnabled === undefined ? {} : { setEnabled }),
              ...(uninstall === undefined ? {} : { uninstall }),
              ...(useInConversation === undefined ? {} : { useInConversation: async (name: string) => { await useInConversation(name) } }),
            }
          })()}
          onChanged={refreshInstallations}
          onClose={() => { setSelected(undefined) }}
          returnFocus={selected.opener}
          t={t}
        />
      )}
    </main>
  )
}

function ManagedSkills({
  state, setEnabled, uninstall, onChanged, t,
}: {
  readonly state: InstallationState
  readonly setEnabled: NonNullable<SkillCenterPageProps['setEnabled']>
  readonly uninstall: NonNullable<SkillCenterPageProps['uninstall']>
  readonly onChanged: () => void
  readonly t: (key: SkillCenterKey) => string
}) {
  if (state.status === 'loading') return <div className={css.state} role="status">{t('mine.loading')}</div>
  if (state.status === 'failure') return <div className={css.state} role="alert">{t('mine.failure')}</div>
  if (state.items.length === 0) return <div className={css.state}>{t('mine.empty')}</div>
  return (
    <div className={css.grid}>
      {state.items.map(item => <ManagedSkillCard key={`${item.registryInstanceId}:${item.namespace}/${item.slug}@${item.version}`} item={item} setEnabled={setEnabled} uninstall={uninstall} onChanged={onChanged} t={t} />)}
    </div>
  )
}

function InventorySkills({
  state, search, filter, onSearch, onFilter, setEnabled, uninstall, onChanged, t,
}: {
  readonly state: InventoryState
  readonly search: string
  readonly filter: 'all' | 'installed'
  readonly onSearch: (value: string) => void
  readonly onFilter: (value: 'all' | 'installed') => void
  readonly setEnabled: NonNullable<SkillCenterPageProps['setEnabled']>
  readonly uninstall: NonNullable<SkillCenterPageProps['uninstall']>
  readonly onChanged: () => void
  readonly t: (key: SkillCenterKey) => string
}) {
  if (state.status === 'loading') return <div className={css.state} role="status">{t('mine.loading')}</div>
  if (state.status === 'failure') return <div className={css.state} role="alert">{t('mine.failure')}</div>
  const normalized = search.trim().toLocaleLowerCase()
  const items = state.items.filter(item => (filter === 'all' || item.installed) && (
    normalized === ''
    || [item.title, item.name, item.description, item.publisher].some(value => value.toLocaleLowerCase().includes(normalized))
  ))
  return <>
    <div className={css.discoveryControls}>
      <label className={css.search}>
        <IconSearchOutline16 size={16} />
        <input
          type="search"
          aria-label={t('mine.search.label')}
          placeholder={t('mine.search.placeholder')}
          value={search}
          onChange={(event) => { onSearch(event.currentTarget.value) }}
        />
      </label>
      <select
        className={css.sort}
        aria-label={t('mine.filter.label')}
        value={filter}
        onChange={(event) => { onFilter(event.currentTarget.value as 'all' | 'installed') }}
      >
        <option value="all">{t('mine.filter.all')}</option>
        <option value="installed">{t('mine.filter.installed')}</option>
      </select>
    </div>
    {items.length === 0 ? <div className={css.state}>{t('mine.empty')}</div> : (
      <div className={css.grid}>
        {items.map(item => <InventoryCard key={`${item.name}:${item.source}:${item.provider}:${item.resolvedPath ?? ''}`} item={item} setEnabled={setEnabled} uninstall={uninstall} onChanged={onChanged} t={t} />)}
      </div>
    )}
  </>
}

function InventoryCard({
  item, setEnabled, uninstall, onChanged, t,
}: {
  readonly item: SkillInventoryEntry
  readonly setEnabled: NonNullable<SkillCenterPageProps['setEnabled']>
  readonly uninstall: NonNullable<SkillCenterPageProps['uninstall']>
  readonly onChanged: () => void
  readonly t: (key: SkillCenterKey) => string
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const identity = item.registryInstanceId === undefined || item.namespace === undefined
    || item.slug === undefined || item.version === undefined
    ? undefined
    : { registryInstanceId: item.registryInstanceId, namespace: item.namespace, slug: item.slug, version: item.version }
  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true); setFailed(false)
    try { await operation(); onChanged() } catch { setFailed(true) } finally { setBusy(false) }
  }
  return <article className={css.card}>
    <div className={css.cardTop}><div className={css.skillIcon}><IconSkillOutline16 size={20} /></div><span className={item.resolved ? css.enabledBadge : css.disabledBadge}>{item.resolved ? t('mine.resolved') : t('mine.notResolved')}</span></div>
    <div className={css.identity}>{item.source} · {item.provider}</div>
    <h2>{item.title}</h2>
    <p className={css.description}>{item.description}</p>
    <div className={css.publisher}>{item.publisher}{item.resolvedPath === undefined ? '' : ` · ${item.resolvedPath}`}</div>
    <footer className={css.cardFooter}>
      {failed && <span className={css.downloadFailure} role="alert">{t('mine.action.failure')}</span>}
      {!item.readOnly && identity !== undefined && <>
        <button type="button" disabled={busy} onClick={() => { void mutate(() => setEnabled(identity, !item.enabled)) }}>{item.enabled ? t('mine.disable') : t('mine.enable')}</button>
        <button type="button" disabled={busy} onClick={() => { void mutate(() => uninstall(identity)) }}>{t('mine.uninstall')}</button>
      </>}
    </footer>
  </article>
}

function ManagedSkillCard({
  item, setEnabled, uninstall, onChanged, t,
}: {
  readonly item: ManagedSkillInstallationEntry
  readonly setEnabled: NonNullable<SkillCenterPageProps['setEnabled']>
  readonly uninstall: NonNullable<SkillCenterPageProps['uninstall']>
  readonly onChanged: () => void
  readonly t: (key: SkillCenterKey) => string
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true); setFailed(false)
    try { await operation(); onChanged() } catch { setFailed(true) } finally { setBusy(false) }
  }
  const identity = identityFor(item)
  return (
    <article className={css.card}>
      <div className={css.cardTop}><div className={css.skillIcon}><IconSkillOutline16 size={20} /></div><span className={item.enabled ? css.enabledBadge : css.disabledBadge}>{item.enabled ? t('mine.enabled') : t('mine.disabled')}</span></div>
      <div className={css.identity}>{item.namespace}/{item.slug}</div>
      <h2>{item.canonicalName}</h2>
      <p className={css.description}>v{item.version}</p>
      <div className={css.publisher}>{item.fingerprint}</div>
      <footer className={css.cardFooter}>
        {failed && <span className={css.downloadFailure} role="alert">{t('mine.action.failure')}</span>}
        <button type="button" disabled={busy} onClick={() => { void mutate(() => setEnabled(identity, !item.enabled)) }}>{item.enabled ? t('mine.disable') : t('mine.enable')}</button>
        <button type="button" disabled={busy} onClick={() => { void mutate(() => uninstall(identity)) }}>{busy ? t('mine.uninstalling') : t('mine.uninstall')}</button>
      </footer>
    </article>
  )
}

function isMarketplaceUnavailable(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'skill-marketplace-unavailable'
}

function listRequest(query: string, label: string, sort: string, page: number): CommunitySkillListPayload {
  return {
    ...(query === '' ? {} : { query }),
    ...(label === '' ? {} : { label }),
    sort,
    page,
    pageSize: PAGE_SIZE,
  }
}

function identityFor(skill: CommunitySkillEntry | ManagedSkillInstallationEntry): CommunitySkillIdentityPayload {
  return {
    registryInstanceId: skill.registryInstanceId,
    namespace: skill.namespace,
    slug: skill.slug,
    version: skill.version,
  }
}

function sameIdentity(left: CommunitySkillIdentityPayload, right: CommunitySkillIdentityPayload): boolean {
  return left.registryInstanceId === right.registryInstanceId
    && left.namespace === right.namespace
    && left.slug === right.slug
    && left.version === right.version
}

function RetryButton({ label, onClick, disabled = false }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className={css.retry} onClick={onClick} disabled={disabled}>
      <IconRefreshOutline16 size={16} />
      {label}
    </button>
  )
}
