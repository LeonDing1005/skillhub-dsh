/** Host-owned Community Skill catalog normalized from SkillHub. */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CommunitySkillListRequest, CommunitySkillPage, RegistryInstanceId } from './types.ts'
import { registryInstanceId } from './types.ts'
import { SkillHubAdapter } from './skillhub.ts'

export type {
  CommunitySkillIdentity,
  CommunitySkillLabel,
  CommunitySkillListRequest,
  CommunitySkillPage,
  CommunitySkillSummary,
  RegistryInstanceId,
} from './types.ts'
export { registryInstanceId } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    skillMarketplace: SkillMarketplace
  }
}

/** SkillHub adapter configuration owned by the Host. */
export interface Config {
  /** Stable identity independent from the Registry Instance URL. */
  registryInstanceId: string
  /** Root URL of the configured SkillHub Registry Instance. */
  baseUrl: string
  /** Maximum catalog items accepted per request. */
  pageSizeLimit?: number
}

/** Dependencies that make the adapter deterministic in tests. */
export interface SkillMarketplaceOptions {
  readonly fetch: typeof globalThis.fetch
  readonly now: () => Date
}

/** Host-side SkillHub adapter exposed through dsh-owned catalog types. */
export class SkillMarketplace extends Service {
  static Config: z<Config> = z.object({
    registryInstanceId: z.string().required(),
    baseUrl: z.string().required(),
    pageSizeLimit: z.number().default(20),
  })

  /** Stable configured Registry Instance identity attached to every result. */
  readonly registryInstanceId: RegistryInstanceId

  constructor(
    ctx: Context,
    readonly config: Config,
    readonly options: SkillMarketplaceOptions = { fetch: globalThis.fetch, now: () => new Date() },
  ) {
    super(ctx, 'skillMarketplace')
    assertConfig(config)
    this.registryInstanceId = registryInstanceId(config.registryInstanceId)
  }

  /**
   * List one normalized Community Skills page.
   * @param request - optional query, label, and zero-based pagination.
   * @param signal - cancellation forwarded to every upstream request.
   * @returns dsh-owned catalog data; no SkillHub response object escapes.
   */
  async list(request: CommunitySkillListRequest = {}, signal?: AbortSignal): Promise<CommunitySkillPage> {
    return new SkillHubAdapter({
      baseUrl: this.config.baseUrl,
      registryInstanceId: this.registryInstanceId,
      pageSizeLimit: this.config.pageSizeLimit ?? 20,
      fetch: this.options.fetch,
      now: this.options.now,
    }).list(request, signal)
  }
}

/** Reject self-contained deployment errors before the plugin starts serving calls. */
function assertConfig(config: Config): void {
  if (config.registryInstanceId.trim() === '') {
    throw new Error('skill-marketplace: registryInstanceId must not be empty')
  }
  const baseUrl = new URL(config.baseUrl)
  if ((baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') || baseUrl.username !== '' || baseUrl.password !== '') {
    throw new Error('skill-marketplace: baseUrl must be an HTTP(S) URL without credentials')
  }
  const pageSizeLimit = config.pageSizeLimit ?? 20
  if (!Number.isInteger(pageSizeLimit) || pageSizeLimit < 1) {
    throw new Error('skill-marketplace: pageSizeLimit must be a positive integer')
  }
}

export default SkillMarketplace
