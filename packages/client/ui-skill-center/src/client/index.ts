/** Native Skill Center route, sidebar entry, and Community Skills Remote projection. */
import type {
  CommunitySkillIdentityPayload, CommunitySkillListPayload, ConnectionHandle,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createElement } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ShellPageId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { SkillCenterPage, type SkillCenterPageProps } from './SkillCenterPage.tsx'
import { SkillCenterTrigger } from './SkillCenterTrigger.tsx'
import { en, zh, type SkillCenterKey } from './locales.ts'

export { SkillCenterPage } from './SkillCenterPage.tsx'
export type { SkillCenterPageProps } from './SkillCenterPage.tsx'

/** Stable shell page id used by the route and its sidebar trigger. */
export const SKILL_CENTER_PAGE_ID = 'skill-center' as ShellPageId
const NS = 'skillCenter'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Skill Center navigation and catalog copy. */
    skillCenter: SkillCenterKey
  }
}

type RouteProps = PropsRuntime<'shell.page'> & PropsLocale<'skillCenter'>
  & Pick<SkillCenterPageProps, 'load' | 'loadDetail' | 'download'>

function SkillCenterRoute({ pageId, load, loadDetail, download, t }: RouteProps) {
  if (pageId !== SKILL_CENTER_PAGE_ID) return null
  return createElement(SkillCenterPage, {
    load,
    ...(loadDetail === undefined ? {} : { loadDetail }),
    ...(download === undefined ? {} : { download }),
    t,
  })
}

export const inject = ['slots', 'layout', 'locale', 'connection']

/** Register the Skill Center center page and sidebar action. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-skill-center: dictionaries')
  const api = (ctx.get('connection') as ConnectionHandle).api
  const load: SkillCenterPageProps['load'] = async (request: CommunitySkillListPayload, signal) => {
    const { result } = await api.skills.communityList(request, signal)
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value
  }
  const loadDetail: NonNullable<SkillCenterPageProps['loadDetail']> = async (identity, signal) => {
    const { result } = await api.skills.communityGet(identity, signal)
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value
  }
  const download: NonNullable<SkillCenterPageProps['download']> = (identity) => {
    const url = communityDownloadUrl(identity)
    const anchor = document.createElement('a')
    anchor.href = url.href
    anchor.click()
    return Promise.resolve()
  }
  ctx.slots.inject('shell.page', () => ctx.slots.register({
    name: 'shell.page',
    id: String(SKILL_CENTER_PAGE_ID),
    locale: NS,
    inject: () => ({ load, loadDetail, download }),
  }, SkillCenterRoute))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'skill-center',
    order: -10,
    locale: NS,
    inject: () => ({ open: () => { ctx.layout.openPage(SKILL_CENTER_PAGE_ID) } }),
  }, SkillCenterTrigger))
}

function communityDownloadUrl(identity: CommunitySkillIdentityPayload): URL {
  const origin = globalThis.location.origin === 'null' ? 'http://dsh.internal' : globalThis.location.origin
  const url = new URL('/api/skill.download', origin)
  url.search = new URLSearchParams([
    ['registryInstanceId', identity.registryInstanceId],
    ['namespace', identity.namespace],
    ['slug', identity.slug],
    ['version', identity.version],
  ]).toString()
  return url
}
