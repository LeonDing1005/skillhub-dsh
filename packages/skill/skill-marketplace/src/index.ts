/** Host-owned Community Skill catalog normalized from SkillHub. */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  CommunitySkillDetail,
  CommunitySkillDownload,
  CommunitySkillIdentity,
  CommunitySkillListRequest,
  CommunitySkillPage,
  RegistryInstanceId,
} from './types.ts'
import { registryInstanceId } from './types.ts'
import { SkillHubAdapter } from './skillhub.ts'

const DEFAULT_FRESH_TTL_MS = 5 * 60 * 1000
const DEFAULT_STALE_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_RATE_LIMIT_RETRIES = 3
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 250
const DEFAULT_SKILL_MARKDOWN_MAX_BYTES = 1024 * 1024
const DEFAULT_VERSION_COUNT_LIMIT = 1000
const DEFAULT_ZIP_DIRECTORY_MAX_BYTES = 4 * 1024 * 1024
const MAX_ZIP_DIRECTORY_MAX_BYTES = 64 * 1024 * 1024
const MAX_RATE_LIMIT_RETRIES = 10
const MAX_TIMER_DELAY_MS = 2_147_483_647

export type {
  CommunitySkillIdentity,
  CommunitySkillDetail,
  CommunitySkillDownload,
  CommunitySkillFile,
  CommunitySkillLabel,
  CommunitySkillListRequest,
  CommunitySkillPage,
  CommunitySkillSummary,
  CommunitySkillVersion,
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
  /** Age below which a successful list result is returned without revalidation. */
  freshTtlMs?: number
  /** Maximum age at which a successful result may cover an upstream outage. */
  staleTtlMs?: number
  /** Number of local retries after an HTTP 429 response, from zero through ten. */
  rateLimitRetries?: number
  /** Initial delay for exponential HTTP 429 retry. */
  rateLimitBackoffMs?: number
  /** Maximum UTF-8 bytes accepted from an exact release SKILL.md. */
  skillMarkdownMaxBytes?: number
  /** Maximum published versions accepted for one Community Skill. */
  versionCountLimit?: number
  /** Maximum central-directory bytes accepted from an exact release ZIP. */
  zipDirectoryMaxBytes?: number
}

/** Dependencies that make the adapter deterministic in tests. */
export interface SkillMarketplaceOptions {
  readonly fetch: typeof globalThis.fetch
  readonly now: () => Date
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

/** Host-side SkillHub adapter exposed through dsh-owned catalog types. */
export class SkillMarketplace extends Service {
  static Config: z<Config> = z.object({
    registryInstanceId: z.string().required(),
    baseUrl: z.string().required(),
    pageSizeLimit: z.number().default(20),
    freshTtlMs: z.number().default(DEFAULT_FRESH_TTL_MS),
    staleTtlMs: z.number().default(DEFAULT_STALE_TTL_MS),
    rateLimitRetries: z.number().default(DEFAULT_RATE_LIMIT_RETRIES),
    rateLimitBackoffMs: z.number().default(DEFAULT_RATE_LIMIT_BACKOFF_MS),
    skillMarkdownMaxBytes: z.number().default(DEFAULT_SKILL_MARKDOWN_MAX_BYTES),
    versionCountLimit: z.number().default(DEFAULT_VERSION_COUNT_LIMIT),
    zipDirectoryMaxBytes: z.number().default(DEFAULT_ZIP_DIRECTORY_MAX_BYTES),
  })

  /** Stable configured Registry Instance identity attached to every result. */
  readonly registryInstanceId: RegistryInstanceId
  private readonly adapter: SkillHubAdapter

  constructor(
    ctx: Context,
    readonly config: Config,
    readonly options: SkillMarketplaceOptions = { fetch: globalThis.fetch, now: () => new Date() },
  ) {
    super(ctx, 'skillMarketplace')
    const resolved = resolveConfig(config)
    this.registryInstanceId = resolved.registryInstanceId
    this.adapter = new SkillHubAdapter({
      baseUrl: resolved.baseUrl,
      registryInstanceId: this.registryInstanceId,
      pageSizeLimit: resolved.pageSizeLimit,
      freshTtlMs: resolved.freshTtlMs,
      staleTtlMs: resolved.staleTtlMs,
      rateLimitRetries: resolved.rateLimitRetries,
      rateLimitBackoffMs: resolved.rateLimitBackoffMs,
      skillMarkdownMaxBytes: resolved.skillMarkdownMaxBytes,
      versionCountLimit: resolved.versionCountLimit,
      zipDirectoryMaxBytes: resolved.zipDirectoryMaxBytes,
      fetch: options.fetch,
      now: options.now,
      sleep: options.sleep ?? abortableDelay,
    })
  }

  /**
   * List one normalized Community Skills page.
   * @param request - optional query, label, and zero-based pagination.
   * @param signal - cancellation forwarded to every upstream request.
   * @returns dsh-owned catalog data; no SkillHub response object escapes.
   */
  async list(request: CommunitySkillListRequest = {}, signal?: AbortSignal): Promise<CommunitySkillPage> {
    return this.adapter.list(request, signal)
  }

  /**
   * Inspect one exact Community Skill release.
   * @param identity - configured Registry Instance and exact upstream release identity.
   * @param signal - cancellation forwarded to every upstream request.
   * @returns Host-normalized detail including the exact SKILL.md source.
   */
  async get(identity: CommunitySkillIdentity, signal?: AbortSignal): Promise<CommunitySkillDetail> {
    return this.adapter.get(identity, signal)
  }

  /**
   * Stream one exact Community Skill artifact without changing local installation state.
   * @param identity - configured Registry Instance and exact upstream release identity.
   * @param signal - cancellation forwarded to every upstream request and body stream.
   * @returns artifact metadata and upstream response stream.
   */
  async download(identity: CommunitySkillIdentity, signal?: AbortSignal): Promise<CommunitySkillDownload> {
    return this.adapter.download(identity, signal)
  }
}

interface ResolvedConfig {
  readonly registryInstanceId: RegistryInstanceId
  readonly baseUrl: string
  readonly pageSizeLimit: number
  readonly freshTtlMs: number
  readonly staleTtlMs: number
  readonly rateLimitRetries: number
  readonly rateLimitBackoffMs: number
  readonly skillMarkdownMaxBytes: number
  readonly versionCountLimit: number
  readonly zipDirectoryMaxBytes: number
}

/** Resolve defaults and reject self-contained deployment errors before serving calls. */
function resolveConfig(config: Config): ResolvedConfig {
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
  const freshTtlMs = config.freshTtlMs ?? DEFAULT_FRESH_TTL_MS
  const staleTtlMs = config.staleTtlMs ?? DEFAULT_STALE_TTL_MS
  if (!Number.isSafeInteger(freshTtlMs) || freshTtlMs < 0) {
    throw new Error('skill-marketplace: freshTtlMs must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(staleTtlMs) || staleTtlMs < freshTtlMs) {
    throw new Error('skill-marketplace: staleTtlMs must be a safe integer greater than or equal to freshTtlMs')
  }
  const rateLimitRetries = config.rateLimitRetries ?? DEFAULT_RATE_LIMIT_RETRIES
  if (!Number.isSafeInteger(rateLimitRetries) || rateLimitRetries < 0 || rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
    throw new Error(`skill-marketplace: rateLimitRetries must be an integer from 0 through ${MAX_RATE_LIMIT_RETRIES}`)
  }
  const rateLimitBackoffMs = config.rateLimitBackoffMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS
  if (!Number.isSafeInteger(rateLimitBackoffMs) || rateLimitBackoffMs < 0) {
    throw new Error('skill-marketplace: rateLimitBackoffMs must be a non-negative safe integer')
  }
  const maximumDelay = rateLimitRetries === 0 ? 0 : rateLimitBackoffMs * (2 ** (rateLimitRetries - 1))
  if (!Number.isSafeInteger(maximumDelay) || maximumDelay > MAX_TIMER_DELAY_MS) {
    throw new Error(`skill-marketplace: rate-limit backoff delay must not exceed ${MAX_TIMER_DELAY_MS} milliseconds`)
  }
  const skillMarkdownMaxBytes = config.skillMarkdownMaxBytes ?? DEFAULT_SKILL_MARKDOWN_MAX_BYTES
  if (!Number.isSafeInteger(skillMarkdownMaxBytes) || skillMarkdownMaxBytes < 1) {
    throw new Error('skill-marketplace: skillMarkdownMaxBytes must be a positive safe integer')
  }
  const versionCountLimit = config.versionCountLimit ?? DEFAULT_VERSION_COUNT_LIMIT
  if (!Number.isSafeInteger(versionCountLimit) || versionCountLimit < 1) {
    throw new Error('skill-marketplace: versionCountLimit must be a positive safe integer')
  }
  const zipDirectoryMaxBytes = config.zipDirectoryMaxBytes ?? DEFAULT_ZIP_DIRECTORY_MAX_BYTES
  if (!Number.isSafeInteger(zipDirectoryMaxBytes) || zipDirectoryMaxBytes < 1
    || zipDirectoryMaxBytes > MAX_ZIP_DIRECTORY_MAX_BYTES) {
    throw new Error(`skill-marketplace: zipDirectoryMaxBytes must be an integer from 1 through ${MAX_ZIP_DIRECTORY_MAX_BYTES}`)
  }
  return {
    registryInstanceId: registryInstanceId(config.registryInstanceId),
    baseUrl: config.baseUrl,
    pageSizeLimit,
    freshTtlMs,
    staleTtlMs,
    rateLimitRetries,
    rateLimitBackoffMs,
    skillMarkdownMaxBytes,
    versionCountLimit,
    zipDirectoryMaxBytes,
  }
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return new Promise((resolve) => { setTimeout(resolve, milliseconds) })
  const abortSignal = signal
  if (abortSignal.aborted) return Promise.reject(abortReason(abortSignal))
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds)
    function done(): void {
      abortSignal.removeEventListener('abort', aborted)
      resolve()
    }
    function aborted(): void {
      clearTimeout(timeout)
      reject(abortReason(abortSignal))
    }
    abortSignal.addEventListener('abort', aborted, { once: true })
  })
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Community Skill request was aborted', { cause: signal.reason })
}

export default SkillMarketplace
