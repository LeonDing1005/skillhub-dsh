/** Native Skill Center route, sidebar entry, and Community Skills Remote projection. */
import type {
  CommunitySkillIdentityPayload, CommunitySkillListPayload, ConnectionHandle,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createElement } from 'react'
import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
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

/** Narrow conversation face needed by this route; the provider is resolved from the Session scope. */
interface ConversationInsertFace {
  /** Insert a canonical skill token and focus the mounted composer. */
  insertSkillToken(name: string): void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Skill Center navigation and catalog copy. */
    skillCenter: SkillCenterKey
  }
}

type RouteProps = PropsRuntime<'shell.page'> & PropsLocale<'skillCenter'>
  & Pick<SkillCenterPageProps, 'load' | 'loadDetail' | 'download' | 'loadInstallations' | 'install' | 'update' | 'setEnabled' | 'uninstall' | 'useInConversation'>

function SkillCenterRoute({ pageId, t, ...props }: RouteProps) {
  if (pageId !== SKILL_CENTER_PAGE_ID) return null
  return createElement(SkillCenterPage, { ...props, t })
}

export const inject = ['slots', 'layout', 'locale', 'connection', 'sessions']

/** Register the Skill Center center page and sidebar action. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-skill-center: dictionaries')
  const api = (ctx.get('connection') as ConnectionHandle).api
  const sessions = ctx.get('sessions') as ISessions
  const useInConversation: NonNullable<SkillCenterPageProps['useInConversation']> = async (name) => {
    const snapshot = sessions.list.getSnapshot()
    let current = snapshot.current
    if (current === undefined) {
      const ordinary = snapshot.ids
        .map(id => snapshot.byId[id])
        .filter((item): item is NonNullable<typeof item> => item !== undefined && item.origin !== 'subagent' && !item.blank)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0]
      current = ordinary?.id
    }
    if (current === undefined) {
      const created = await sessions.create()
      sessions.open(created)
      current = created
    }
    const scope = sessions.scope(current)
    if (scope === undefined) throw new Error(`skill-center: session "${current}" is unavailable`)
    const conversation = scope.get('conversation') as ConversationInsertFace
    conversation.insertSkillToken(name)
    ctx.layout.showConversation()
  }
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
  const loadInstallations: NonNullable<SkillCenterPageProps['loadInstallations']> = async (signal) => {
    if (api.skills.installationList === undefined) throw new Error('managed installation RPC unavailable')
    const { result } = await api.skills.installationList({}, signal)
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value
  }
  const install: NonNullable<SkillCenterPageProps['install']> = async (identity) => {
    if (api.skills.installationInstall === undefined) throw new Error('managed installation RPC unavailable')
    const { result } = await api.skills.installationInstall({ ...identity, idempotencyKey: idempotencyKey() })
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value
  }
  const update: NonNullable<SkillCenterPageProps['update']> = async (identity, fromVersion) => {
    if (api.skills.installationUpdate === undefined) throw new Error('managed installation RPC unavailable')
    const { result } = await api.skills.installationUpdate({ ...identity, fromVersion, idempotencyKey: idempotencyKey() })
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value
  }
  const setEnabled: NonNullable<SkillCenterPageProps['setEnabled']> = async (identity, enabled) => {
    if (api.skills.installationSetEnabled === undefined) throw new Error('managed installation RPC unavailable')
    const { result } = await api.skills.installationSetEnabled({ ...identity, enabled, idempotencyKey: idempotencyKey() })
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value
  }
  const uninstall: NonNullable<SkillCenterPageProps['uninstall']> = async (identity) => {
    if (api.skills.installationUninstall === undefined) throw new Error('managed installation RPC unavailable')
    const { result } = await api.skills.installationUninstall({ ...identity, idempotencyKey: idempotencyKey() })
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value
  }
  ctx.slots.inject('shell.page', () => ctx.slots.register({
    name: 'shell.page',
    id: String(SKILL_CENTER_PAGE_ID),
    locale: NS,
    inject: () => ({ load, loadDetail, download, loadInstallations, install, update, setEnabled, uninstall, useInConversation }),
  }, SkillCenterRoute))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'skill-center',
    order: -10,
    locale: NS,
    inject: () => ({ open: () => { ctx.layout.openPage(SKILL_CENTER_PAGE_ID) } }),
  }, SkillCenterTrigger))
}

function idempotencyKey(): string {
  return globalThis.crypto.randomUUID()
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
