import { IconSkillOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SkillCenterTrigger.module.css'

export type SkillCenterTriggerProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'skillCenter'> & {
  readonly open: () => void
}

/** Sidebar entry that opens the native Skill Center page. */
export function SkillCenterTrigger({ wide, open, t }: SkillCenterTriggerProps) {
  return (
    <Tooltip label={t('title')} disabled={wide} delayMs={500}>
      <button type="button" className={wide ? css.trigger : `${css.trigger} ${css.rail}`} aria-label={t('title')} onClick={open}>
        <IconSkillOutline16 size={wide ? 16 : 18} />
        {wide && <span>{t('title')}</span>}
      </button>
    </Tooltip>
  )
}
