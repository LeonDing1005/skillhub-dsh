/** Community Skills page with deterministic loading, empty, failure, and catalog states. */
import { useCallback, useEffect, useState } from 'react'
import {
  IconDownloadOutline16, IconRefreshOutline16, IconSkillOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { CommunitySkillListValue } from '@deepseek-ai/dsh-api-remotes/client'
import type { SkillCenterKey } from './locales.ts'
import css from './SkillCenterPage.module.css'

/** Pure page inputs; the slot route supplies the Remote-backed loader. */
export interface SkillCenterPageProps {
  readonly load: (signal: AbortSignal) => Promise<CommunitySkillListValue>
  readonly t: (key: SkillCenterKey) => string
}

type CatalogState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: CommunitySkillListValue }
  | { readonly status: 'failure' }

/** Render the enabled Community Skills catalog and the disabled My Skills tab. */
export function SkillCenterPage({ load, t }: SkillCenterPageProps) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<CatalogState>({ status: 'loading' })
  useEffect(() => {
    const abort = new AbortController()
    setState({ status: 'loading' })
    load(abort.signal).then(
      (value) => { if (!abort.signal.aborted) setState({ status: 'ready', value }) },
      () => { if (!abort.signal.aborted) setState({ status: 'failure' }) },
    )
    return () => { abort.abort() }
  }, [attempt, load])
  const retry = useCallback(() => { setAttempt(value => value + 1) }, [])

  return (
    <main className={css.root} aria-label={t('title')}>
      <header className={css.header}>
        <div className={css.titleRow}>
          <IconSkillOutline16 size={22} />
          <h1>{t('title')}</h1>
        </div>
        <div className={css.tabs} role="tablist">
          <button type="button" role="tab" aria-selected="true" className={css.activeTab}>{t('tab.community')}</button>
          <button type="button" role="tab" aria-selected="false" disabled>{t('tab.mine')}</button>
        </div>
      </header>
      <section className={css.content}>
        {state.status === 'loading' && <div className={css.state} role="status">{t('loading')}</div>}
        {state.status === 'failure' && (
          <div className={css.state} role="alert">
            <strong>{t('failure.title')}</strong>
            <button type="button" className={css.retry} onClick={retry}>
              <IconRefreshOutline16 size={16} />
              {t('retry')}
            </button>
          </div>
        )}
        {state.status === 'ready' && state.value.items.length === 0 && (
          <div className={css.state}>{t('empty.title')}</div>
        )}
        {state.status === 'ready' && state.value.items.length > 0 && (
          <div className={css.grid}>
            {state.value.items.map(skill => (
              <article
                key={`${skill.registryInstanceId}:${skill.namespace}/${skill.slug}@${skill.version}`}
                className={css.card}
              >
                <div className={css.cardTop}>
                  <div className={css.skillIcon}><IconSkillOutline16 size={20} /></div>
                  {skill.isNew && <span className={css.newBadge}>{t('new')}</span>}
                </div>
                <div className={css.identity}>{skill.namespace}/{skill.slug}</div>
                <h2>{skill.title}</h2>
                <p className={css.description}>{skill.description}</p>
                <div className={css.publisher}>{skill.publisher}</div>
                <div className={css.labels}>
                  {skill.labels.map(label => <span key={label}>{label}</span>)}
                </div>
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
        )}
      </section>
    </main>
  )
}
