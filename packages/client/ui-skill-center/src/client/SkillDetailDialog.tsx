/** Exact Community Skill detail and download dialog. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconCloseOutline16, IconCopyOutline16, IconDownloadOutline16, MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CommunitySkillDetailValue, CommunitySkillEntry, CommunitySkillIdentityPayload,
  ManagedSkillInstallationEntry,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SkillCenterKey } from './locales.ts'
import css from './SkillCenterPage.module.css'

/** Pure detail-dialog inputs supplied by the Skill Center route. */
export interface SkillDetailDialogProps {
  readonly skill: CommunitySkillEntry
  readonly load: (identity: CommunitySkillIdentityPayload, signal: AbortSignal) => Promise<CommunitySkillDetailValue>
  readonly download: (identity: CommunitySkillIdentityPayload) => Promise<void>
  readonly installation?: ManagedSkillInstallationEntry
  readonly install?: (identity: CommunitySkillIdentityPayload) => Promise<ManagedSkillInstallationEntry>
  readonly update?: (identity: CommunitySkillIdentityPayload, fromVersion: string) => Promise<ManagedSkillInstallationEntry>
  readonly setEnabled?: (identity: CommunitySkillIdentityPayload, enabled: boolean) => Promise<ManagedSkillInstallationEntry>
  readonly uninstall?: (identity: CommunitySkillIdentityPayload) => Promise<{ removed: boolean }>
  /** Return to the current conversation and insert the canonical slash token. */
  readonly useInConversation?: (name: string) => Promise<void> | void
  readonly onChanged?: () => void
  readonly onClose: () => void
  readonly returnFocus: HTMLElement | null
  readonly t: (key: SkillCenterKey) => string
}

type DetailState =
  | { readonly status: 'loading' }
  | { readonly status: 'failure' }
  | { readonly status: 'ready'; readonly value: CommunitySkillDetailValue }

/**
 * Render a modal that inspects and downloads one immutable release.
 * @param props - exact release loaders, dismissal state, and localized copy.
 * @returns a body portal containing the modal dialog.
 */
export function SkillDetailDialog({
  skill, load, download, installation: initialInstallation, install, update, setEnabled,
  uninstall, useInConversation, onChanged, onClose, returnFocus, t,
}: SkillDetailDialogProps) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<DetailState>({ status: 'loading' })
  const [mode, setMode] = useState<'dsh' | 'local'>('dsh')
  const [copied, setCopied] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadFailed, setDownloadFailed] = useState(false)
  const [installation, setInstallation] = useState(initialInstallation)
  const [action, setAction] = useState<'idle' | 'installing' | 'updating' | 'toggling' | 'uninstalling'>('idle')
  const [actionFailed, setActionFailed] = useState(false)
  const [confirmation, setConfirmation] = useState<'install' | 'update' | undefined>()
  const dialog = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const identity = useMemo(() => identityFor(skill), [
    skill.namespace, skill.registryInstanceId, skill.slug, skill.version,
  ])

  useEffect(() => {
    const abort = new AbortController()
    setState({ status: 'loading' })
    load(identity, abort.signal).then(
      (value) => { if (!abort.signal.aborted) setState({ status: 'ready', value }) },
      () => { if (!abort.signal.aborted) setState({ status: 'failure' }) },
    )
    return () => { abort.abort() }
  }, [attempt, identity, load])

  useEffect(() => {
    close.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || dialog.current === null) return
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable.at(-1)
      if (first === undefined || last === undefined) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      returnFocus?.focus()
    }
  }, [onClose, returnFocus])

  const copyCommand = useCallback(async () => {
    if (state.status !== 'ready') return
    try {
      await navigator.clipboard.writeText(state.value.installCommand)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }, [state])

  const downloadRelease = useCallback(async () => {
    setDownloading(true)
    setDownloadFailed(false)
    try {
      await download(identity)
    } catch {
      setDownloadFailed(true)
    } finally {
      setDownloading(false)
    }
  }, [download, identity])

  useEffect(() => { setInstallation(initialInstallation) }, [initialInstallation])

  const mutateInstallation = useCallback(async (
    operation: () => Promise<ManagedSkillInstallationEntry | { removed: boolean }>,
    nextAction: typeof action,
  ) => {
    setAction(nextAction)
    setActionFailed(false)
    try {
      const result = await operation()
      if ('removed' in result) setInstallation(undefined)
      else setInstallation(result)
      onChanged?.()
    } catch {
      setActionFailed(true)
    } finally {
      setAction('idle')
    }
  }, [onChanged])

  const installRelease = useCallback(() => {
    if (install === undefined) return
    if (confirmation !== 'install') { setConfirmation('install'); return }
    setConfirmation(undefined)
    void mutateInstallation(() => install(identity), 'installing')
  }, [confirmation, identity, install, mutateInstallation])

  const toggleInstallation = useCallback(() => {
    if (setEnabled === undefined || installation === undefined) return
    void mutateInstallation(() => setEnabled(identity, !installation.enabled), 'toggling')
  }, [identity, installation, mutateInstallation, setEnabled])

  const uninstallRelease = useCallback(() => {
    if (uninstall === undefined || installation === undefined) return
    void mutateInstallation(() => uninstall(identity), 'uninstalling')
  }, [identity, installation, mutateInstallation, uninstall])

  const newestVersion = state.status === 'ready'
    ? state.value.versions.map(item => item.version).sort(compareVersions).at(-1)
    : undefined
  const canUpdate = installation !== undefined
    && update !== undefined
    && newestVersion !== undefined
    && compareVersions(newestVersion, installation.version) > 0

  return createPortal((
    <div className={css.dialogLayer} data-testid="skill-detail-layer">
      <div className={css.dialogMask} aria-hidden="true" onClick={onClose} />
      <div ref={dialog} className={css.dialog} role="dialog" aria-modal="true" aria-labelledby="skill-detail-title">
        <header className={css.dialogHeader}>
          <div>
            <div className={css.dialogIdentity}>{skill.namespace}/{skill.slug}</div>
            <h2 id="skill-detail-title">{state.status === 'ready' ? state.value.canonicalName : skill.title}</h2>
            <div className={css.dialogMeta}>
              <span>{state.status === 'ready' ? state.value.publisher : skill.publisher}</span>
              <span>v{skill.version}</span>
              <span>{state.status === 'ready' ? state.value.starCount : skill.starCount} {t('stars')}</span>
              <span>{state.status === 'ready' ? state.value.downloadCount : skill.downloadCount} {t('downloads')}</span>
            </div>
          </div>
          <button ref={close} type="button" className={css.iconButton} aria-label={t('detail.close')} onClick={onClose}>
            <IconCloseOutline16 size={16} />
          </button>
        </header>

        {state.status === 'loading' && <div className={css.dialogState} role="status">{t('detail.loading')}</div>}
        {state.status === 'failure' && (
          <div className={css.dialogState} role="alert">
            <span>{t('detail.failure')}</span>
            <button type="button" onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</button>
          </div>
        )}
        {state.status === 'ready' && (
          <>
            <div className={css.modeSwitch} aria-label={t('detail.mode')}>
              <button type="button" aria-pressed={mode === 'dsh'} onClick={() => { setMode('dsh') }}>{t('detail.mode.dsh')}</button>
              <button type="button" aria-pressed={mode === 'local'} onClick={() => { setMode('local') }}>{t('detail.mode.local')}</button>
            </div>
            <div className={css.dialogBody}>
              {mode === 'dsh' && state.value.examplePrompt !== undefined && (
                <section>
                  <h3>{t('detail.example')}</h3>
                  <p className={css.examplePrompt}>{state.value.examplePrompt}</p>
                </section>
              )}
              {mode === 'local' && (
                <section>
                  <h3>{t('detail.command')}</h3>
                  <div className={css.commandRow}>
                    <code>{state.value.installCommand}</code>
                    <button type="button" className={css.iconButton} aria-label={t('detail.copy')} onClick={() => { void copyCommand() }}>
                      <IconCopyOutline16 size={16} />
                    </button>
                  </div>
                  {copied && <div className={css.copied} role="status">{t('detail.copied')}</div>}
                </section>
              )}
              <section className={css.previewSection}>
                <h3>SKILL.md</h3>
                <div className={css.markdownPreview}>
                  <MarkdownText
                    text={state.value.skillMarkdown}
                    allowRemoteImages={false}
                    codeLabels={{ copyLabel: t('detail.code.copy'), copiedLabel: t('detail.code.copied') }}
                  />
                </div>
              </section>
            </div>
            <footer className={css.dialogFooter}>
              {downloadFailed && <span className={css.downloadFailure} role="alert">{t('detail.download.failure')}</span>}
              {actionFailed && <span className={css.downloadFailure} role="alert">{t('mine.action.failure')}</span>}
              <button type="button" onClick={onClose}>{t('detail.cancel')}</button>
              {installation === undefined && install !== undefined && confirmation !== 'install' && (
                <button type="button" className={css.primaryAction} disabled={action !== 'idle'} onClick={installRelease}>
                  {action === 'installing' ? t('mine.installing') : t('mine.install')}
                </button>
              )}
              {installation === undefined && install !== undefined && confirmation === 'install' && (
                <span className={css.confirmation} role="group" aria-label={t('mine.confirm.install')}>
                  <span>{t('mine.confirm.install')}</span>
                  <small>{state.value.publisher} · {state.value.registryInstanceId} · v{skill.version} · {state.value.files.length > 1 ? t('mine.confirm.resources') : t('mine.confirm.noResources')}</small>
                  <button type="button" onClick={installRelease}>{t('mine.confirm')}</button>
                  <button type="button" onClick={() => { setConfirmation(undefined) }}>{t('detail.cancel')}</button>
                </span>
              )}
              {installation !== undefined && setEnabled !== undefined && (
                <button type="button" className={css.primaryAction} disabled={action !== 'idle'} onClick={toggleInstallation}>
                  {installation.enabled ? t('mine.disable') : t('mine.enable')}
                </button>
              )}
              {canUpdate && confirmation !== 'update' && (
                <button type="button" className={css.primaryAction} disabled={action !== 'idle'} onClick={() => { setConfirmation('update') }}>
                  {action === 'updating' ? t('mine.updating') : `${t('mine.update')} v${newestVersion}`}
                </button>
              )}
              {canUpdate && confirmation === 'update' && (
                <span className={css.confirmation} role="group" aria-label={t('mine.confirm.update')}>
                  <span>{t('mine.confirm.update')}</span>
                  <small>{state.value.publisher} · {state.value.registryInstanceId} · v{newestVersion}</small>
                  <button type="button" onClick={() => { setConfirmation(undefined); void mutateInstallation(() => update(identity, installation.version), 'updating') }}>{t('mine.confirm')}</button>
                  <button type="button" onClick={() => { setConfirmation(undefined) }}>{t('detail.cancel')}</button>
                </span>
              )}
              {installation !== undefined && installation.enabled && useInConversation !== undefined && (
                <button type="button" onClick={() => { void useInConversation(installation.canonicalName) }}>{t('mine.use')}</button>
              )}
              {installation !== undefined && uninstall !== undefined && (
                <button type="button" disabled={action !== 'idle'} onClick={uninstallRelease}>
                  {action === 'uninstalling' ? t('mine.uninstalling') : t('mine.uninstall')}
                </button>
              )}
              <button type="button" className={css.primaryAction} disabled={downloading || action !== 'idle'} onClick={() => { void downloadRelease() }}>
                <IconDownloadOutline16 size={16} />
                {downloading ? t('detail.downloading') : t('detail.download')}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  ), document.body)
}

function identityFor(skill: CommunitySkillEntry): CommunitySkillIdentityPayload {
  return {
    registryInstanceId: skill.registryInstanceId,
    namespace: skill.namespace,
    slug: skill.slug,
    version: skill.version,
  }
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(part => Number.parseInt(part, 10) || 0)
  const b = right.split('.').map(part => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return left.localeCompare(right)
}
