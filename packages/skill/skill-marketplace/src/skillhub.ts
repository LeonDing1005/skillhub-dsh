import type {
  CommunitySkillLabel,
  CommunitySkillListRequest,
  CommunitySkillPage,
  CommunitySkillSummary,
  RegistryInstanceId,
} from './types.ts'

const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

interface AdapterOptions {
  readonly baseUrl: string
  readonly registryInstanceId: RegistryInstanceId
  readonly pageSizeLimit: number
  readonly fetch: typeof globalThis.fetch
  readonly now: () => Date
}

interface ListedSkill {
  readonly namespace: string
  readonly slug: string
  readonly displayName: string
  readonly summary: string
  readonly downloadCount: number
  readonly starCount: number
  readonly version: string
}

interface SkillDetail {
  readonly namespace: string
  readonly slug: string
  readonly ownerDisplayName: string
  readonly labels: readonly string[]
}

interface SkillVersionDetail {
  readonly version: string
  readonly publishedAt?: string
}

/** Upstream or compatibility failure reported through the marketplace interface. */
export class SkillMarketplaceError extends Error {
  /** Stable failure classification for Host transport mapping. */
  readonly code: 'SKILL_MARKETPLACE_UPSTREAM' | 'SKILL_MARKETPLACE_INVALID_RESPONSE'

  constructor(message: string, code: SkillMarketplaceError['code'], options?: ErrorOptions) {
    super(message, options)
    this.name = 'SkillMarketplaceError'
    this.code = code
  }
}

/** SkillHub-specific implementation behind the dsh-owned marketplace interface. */
export class SkillHubAdapter {
  readonly #baseUrl: URL

  constructor(readonly options: AdapterOptions) {
    this.#baseUrl = new URL(options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`)
  }

  /**
   * Normalize one catalog page and enrich fields absent from SkillHub list items.
   * @param request - query, label, and zero-based pagination.
   * @param signal - cancellation forwarded to every upstream request.
   * @returns normalized Community Skills page.
   */
  async list(request: CommunitySkillListRequest, signal?: AbortSignal): Promise<CommunitySkillPage> {
    const page = request.page ?? 0
    const pageSize = request.pageSize ?? this.options.pageSizeLimit
    assertPageInput(page, pageSize, this.options.pageSizeLimit)
    const params = new URLSearchParams({ page: String(page), size: String(pageSize) })
    if (request.query !== undefined && request.query !== '') params.set('q', request.query)
    if (request.label !== undefined && request.label !== '') params.append('label', request.label)

    const pageJson = await this.#json(`/api/web/skills?${params}`, signal)
    const labelsJson = await this.#json('/api/web/labels', signal)
    const listed = parsePage(pageJson)
    const labels = parseLabels(labelsJson)
    const items = await Promise.all(listed.items.map(item => this.#enrich(item, signal)))
    return { items, labels, total: listed.total, page: listed.page, pageSize: listed.pageSize }
  }

  async #enrich(item: ListedSkill, signal?: AbortSignal): Promise<CommunitySkillSummary> {
    const identityPath = `${encodeURIComponent(item.namespace)}/${encodeURIComponent(item.slug)}`
    const detail = parseDetail(await this.#json(`/api/web/skills/${identityPath}`, signal))
    const version = parseVersion(await this.#json(
      `/api/web/skills/${identityPath}/versions/${encodeURIComponent(item.version)}`,
      signal,
    ))
    if (detail.namespace !== item.namespace || detail.slug !== item.slug || version.version !== item.version) {
      throw invalidResponse(`SkillHub identity changed while listing ${item.namespace}/${item.slug}@${item.version}`)
    }
    return {
      identity: {
        registryInstanceId: this.options.registryInstanceId,
        namespace: item.namespace,
        slug: item.slug,
        version: item.version,
      },
      title: item.displayName,
      description: item.summary,
      publisher: detail.ownerDisplayName,
      starCount: item.starCount,
      downloadCount: item.downloadCount,
      labels: detail.labels,
      ...(version.publishedAt === undefined ? {} : { publishedAt: version.publishedAt }),
      isNew: isNewRelease(version.publishedAt, this.options.now()),
    }
  }

  async #json(path: string, signal?: AbortSignal): Promise<unknown> {
    const url = new URL(path.replace(/^\//, ''), this.#baseUrl)
    let response: Response
    try {
      response = await this.options.fetch(url, {
        headers: { accept: 'application/json' },
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason
      throw new SkillMarketplaceError(`SkillHub request failed for ${url.pathname}`, 'SKILL_MARKETPLACE_UPSTREAM', { cause: error })
    }
    if (!response.ok) {
      throw new SkillMarketplaceError(
        `SkillHub request failed for ${url.pathname} with HTTP ${response.status}`,
        'SKILL_MARKETPLACE_UPSTREAM',
      )
    }
    try {
      return await response.json()
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason
      throw invalidResponse(`SkillHub returned invalid JSON for ${url.pathname}`, error)
    }
  }
}

/**
 * Validate the subset of the deployed OpenAPI contract consumed by this adapter.
 * @param input - parsed OpenAPI document supplied by deployment verification.
 */
export function validateSkillHubOpenApi(input: unknown): void {
  const document = record(input, 'OpenAPI document')
  const paths = record(document.paths, 'OpenAPI paths')
  for (const path of [
    '/api/web/skills',
    '/api/web/labels',
    '/api/web/skills/{namespace}/{slug}',
    '/api/web/skills/{namespace}/{slug}/versions/{version}',
  ]) {
    const operation = record(record(paths[path], `OpenAPI path "${path}"`).get, `OpenAPI GET "${path}"`)
    record(operation.responses, `OpenAPI responses for "${path}"`)
  }
  const listOperation = record(record(paths['/api/web/skills'], 'OpenAPI list path').get, 'OpenAPI list GET')
  const parameters = arrayField(listOperation, 'parameters').map(value => stringField(record(value, 'OpenAPI list parameter'), 'name'))
  for (const parameter of ['q', 'namespace', 'label', 'sort', 'page', 'size']) {
    if (!parameters.includes(parameter)) throw invalidResponse(`SkillHub OpenAPI list is missing parameter "${parameter}"`)
  }

  const components = record(document.components, 'OpenAPI components')
  const schemas = record(components.schemas, 'OpenAPI schemas')
  const requiredFields: Readonly<Record<string, readonly string[]>> = {
    SearchResponse: ['items', 'total', 'page', 'size'],
    SkillSummaryResponse: ['slug', 'displayName', 'summary', 'downloadCount', 'starCount', 'namespace', 'publishedVersion'],
    SkillDetailResponse: ['slug', 'ownerDisplayName', 'namespace', 'labels'],
    SkillVersionDetailResponse: ['version', 'publishedAt'],
    SkillLabelDto: ['slug', 'displayName'],
  }
  for (const [schemaName, fields] of Object.entries(requiredFields)) {
    const schema = record(schemas[schemaName], `OpenAPI schema "${schemaName}"`)
    const properties = record(schema.properties, `OpenAPI schema "${schemaName}" properties`)
    for (const field of fields) {
      if (!(field in properties)) throw invalidResponse(`SkillHub OpenAPI schema "${schemaName}" is missing field "${field}"`)
    }
  }
}

function assertPageInput(page: number, pageSize: number, limit: number): void {
  if (!Number.isInteger(page) || page < 0) throw new RangeError('skill-marketplace: page must be a non-negative integer')
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > limit) {
    throw new RangeError(`skill-marketplace: pageSize must be between 1 and ${limit}`)
  }
}

function parsePage(input: unknown): { items: readonly ListedSkill[]; total: number; page: number; pageSize: number } {
  const data = envelopeData(input, 'catalog page')
  const items = arrayField(data, 'items').map((value, index) => {
    const item = record(value, `catalog item ${index}`)
    const publishedVersion = record(item.publishedVersion, `catalog item ${index}.publishedVersion`)
    return {
      namespace: stringField(item, 'namespace'),
      slug: stringField(item, 'slug'),
      displayName: stringField(item, 'displayName'),
      summary: stringField(item, 'summary'),
      downloadCount: nonNegativeIntegerField(item, 'downloadCount'),
      starCount: nonNegativeIntegerField(item, 'starCount'),
      version: stringField(publishedVersion, 'version'),
    }
  })
  return {
    items,
    total: nonNegativeIntegerField(data, 'total'),
    page: nonNegativeIntegerField(data, 'page'),
    pageSize: positiveIntegerField(data, 'size'),
  }
}

function parseLabels(input: unknown): readonly CommunitySkillLabel[] {
  return arrayValue(envelopeDataValue(input, 'labels'), 'labels').map((value, index) => {
    const label = record(value, `label ${index}`)
    return { slug: stringField(label, 'slug'), title: stringField(label, 'displayName') }
  })
}

function parseDetail(input: unknown): SkillDetail {
  const data = envelopeData(input, 'skill detail')
  return {
    namespace: stringField(data, 'namespace'),
    slug: stringField(data, 'slug'),
    ownerDisplayName: stringField(data, 'ownerDisplayName'),
    labels: arrayField(data, 'labels').map((value, index) => stringField(record(value, `skill label ${index}`), 'slug')),
  }
}

function parseVersion(input: unknown): SkillVersionDetail {
  const data = envelopeData(input, 'version detail')
  const publishedAt = data.publishedAt
  if (publishedAt !== undefined && publishedAt !== null && typeof publishedAt !== 'string') {
    throw invalidResponse('SkillHub version detail field "publishedAt" must be a string or null')
  }
  return { version: stringField(data, 'version'), ...(typeof publishedAt === 'string' ? { publishedAt } : {}) }
}

function isNewRelease(publishedAt: string | undefined, now: Date): boolean {
  if (publishedAt === undefined) return false
  const published = Date.parse(publishedAt)
  const clock = now.getTime()
  if (!Number.isFinite(published) || !Number.isFinite(clock)) return false
  const age = clock - published
  return age >= 0 && age <= NEW_WINDOW_MS
}

function envelopeData(input: unknown, subject: string): Record<string, unknown> {
  return record(envelopeDataValue(input, subject), subject)
}

function envelopeDataValue(input: unknown, subject: string): unknown {
  const envelope = record(input, `${subject} envelope`)
  if (numberField(envelope, 'code') !== 0) throw invalidResponse(`SkillHub ${subject} envelope reported failure`)
  return envelope.data
}

function record(input: unknown, subject: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalidResponse(`SkillHub ${subject} must be an object`)
  }
  return input as Record<string, unknown>
}

function arrayField(input: Record<string, unknown>, key: string): readonly unknown[] {
  return arrayValue(input[key], `field "${key}"`)
}

function arrayValue(input: unknown, subject: string): readonly unknown[] {
  if (!Array.isArray(input)) throw invalidResponse(`SkillHub ${subject} must be an array`)
  return input
}

function stringField(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string') throw invalidResponse(`SkillHub field "${key}" must be a string`)
  return value
}

function numberField(input: Record<string, unknown>, key: string): number {
  const value = input[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidResponse(`SkillHub field "${key}" must be a finite number`)
  }
  return value
}

function nonNegativeIntegerField(input: Record<string, unknown>, key: string): number {
  const value = numberField(input, key)
  if (!Number.isInteger(value) || value < 0) {
    throw invalidResponse(`SkillHub field "${key}" must be a non-negative integer`)
  }
  return value
}

function positiveIntegerField(input: Record<string, unknown>, key: string): number {
  const value = numberField(input, key)
  if (!Number.isInteger(value) || value < 1) {
    throw invalidResponse(`SkillHub field "${key}" must be a positive integer`)
  }
  return value
}

function invalidResponse(message: string, cause?: unknown): SkillMarketplaceError {
  return new SkillMarketplaceError(message, 'SKILL_MARKETPLACE_INVALID_RESPONSE', cause === undefined ? undefined : { cause })
}
