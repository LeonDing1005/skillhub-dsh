import type {
  CommunitySkillDetail,
  CommunitySkillDownload,
  CommunitySkillFile,
  CommunitySkillIdentity,
  CommunitySkillLabel,
  CommunitySkillListRequest,
  CommunitySkillPage,
  CommunitySkillSummary,
  CommunitySkillVersion,
  RegistryInstanceId,
} from './types.ts'

const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

interface AdapterOptions {
  readonly baseUrl: string
  readonly registryInstanceId: RegistryInstanceId
  readonly pageSizeLimit: number
  readonly freshTtlMs: number
  readonly staleTtlMs: number
  readonly rateLimitRetries: number
  readonly rateLimitBackoffMs: number
  readonly skillMarkdownMaxBytes: number
  readonly fetch: typeof globalThis.fetch
  readonly now: () => Date
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

interface CacheEntry {
  readonly value: Omit<CommunitySkillPage, 'freshness' | 'lastSuccessfulAt'>
  readonly successfulAt: number
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
  readonly displayName: string
  readonly summary: string
  readonly ownerDisplayName: string
  readonly starCount: number
  readonly downloadCount: number
  readonly labels: readonly string[]
}

interface SkillVersionDetail {
  readonly version: string
  readonly publishedAt?: string
  readonly canonicalName?: string
  readonly examplePrompt?: string
}

/** Upstream or compatibility failure reported through the marketplace interface. */
export class SkillMarketplaceError extends Error {
  /** Stable failure classification for Host transport mapping. */
  readonly code: 'SKILL_MARKETPLACE_UPSTREAM' | 'SKILL_MARKETPLACE_INVALID_RESPONSE' | 'SKILL_MARKETPLACE_UNAVAILABLE'

  constructor(message: string, code: SkillMarketplaceError['code'], options?: ErrorOptions) {
    super(message, options)
    this.name = 'SkillMarketplaceError'
    this.code = code
  }
}

/** SkillHub-specific implementation behind the dsh-owned marketplace interface. */
export class SkillHubAdapter {
  readonly #baseUrl: URL
  readonly #cache = new Map<string, CacheEntry>()
  readonly #cacheGenerations = new Map<string, symbol>()

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
    const normalized = {
      query: request.query ?? '',
      label: request.label ?? '',
      sort: request.sort ?? '',
      page,
      pageSize,
    }
    const cacheKey = JSON.stringify(normalized)
    const cached = this.#cache.get(cacheKey)
    const now = this.options.now()
    if (cached !== undefined && cacheAge(now, cached) <= this.options.freshTtlMs) {
      return cacheValue(cached, 'fresh')
    }
    const generation = Symbol(cacheKey)
    this.#cacheGenerations.set(cacheKey, generation)

    try {
      const value = await this.#load(normalized, signal)
      if (signal?.aborted === true) throw signal.reason
      const successfulAt = this.options.now().getTime()
      if (!Number.isFinite(successfulAt)) return { ...value, freshness: 'fresh' }
      const entry = { value, successfulAt }
      if (this.#cacheGenerations.get(cacheKey) === generation) this.#cache.set(cacheKey, entry)
      return cacheValue(entry, 'fresh')
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason
      if (error instanceof SkillMarketplaceError && error.code === 'SKILL_MARKETPLACE_INVALID_RESPONSE') throw error
      if (cached !== undefined && cacheAge(this.options.now(), cached) <= this.options.staleTtlMs) {
        return cacheValue(cached, 'stale')
      }
      if (cached === undefined && error instanceof SkillMarketplaceError) throw error
      throw new SkillMarketplaceError('Community Skills is unavailable and no recent successful result remains', 'SKILL_MARKETPLACE_UNAVAILABLE', { cause: error })
    } finally {
      if (this.#cacheGenerations.get(cacheKey) === generation) this.#cacheGenerations.delete(cacheKey)
    }
  }

  /**
   * Load and verify one exact release using only dsh-owned return fields.
   * @param identity - exact Community Skill release identity.
   * @param signal - cancellation forwarded to upstream requests.
   * @returns normalized detail and safe-to-present source inputs.
   */
  async get(identity: CommunitySkillIdentity, signal?: AbortSignal): Promise<CommunitySkillDetail> {
    this.#assertRegistry(identity)
    assertInstallIdentity(identity)
    const release = this.#releasePath(identity)
    const [detail, versions, version, files, skillMarkdown, resolved] = await Promise.all([
      this.#json(`/api/web/skills/${release.skill}`, signal).then(parseDetail),
      this.#versions(release.skill, signal),
      this.#json(`/api/web/skills/${release.exact}`, signal).then(parseVersion),
      this.#json(`/api/web/skills/${release.exact}/files`, signal).then(parseFiles),
      this.#text(`/api/web/skills/${release.exact}/file?path=SKILL.md`, 'text/markdown', signal),
      this.#json(`/api/web/skills/${release.skill}/resolve?version=${encodeURIComponent(identity.version)}`, signal).then(parseResolve),
    ])
    assertExactIdentity(identity, detail, version, resolved)
    if (version.canonicalName === undefined) throw invalidResponse('SkillHub release metadata is missing canonical name')
    return {
      identity,
      canonicalName: version.canonicalName,
      title: detail.displayName,
      description: detail.summary,
      publisher: detail.ownerDisplayName,
      starCount: detail.starCount,
      downloadCount: detail.downloadCount,
      ...(version.publishedAt === undefined ? {} : { publishedAt: version.publishedAt }),
      ...(version.examplePrompt === undefined ? {} : { examplePrompt: version.examplePrompt }),
      skillMarkdown,
      versions,
      files,
      installCommand: `skillhub install ${identity.slug} --namespace ${identity.namespace} --version ${identity.version}`,
    }
  }

  /**
   * Verify and stream one exact release artifact.
   * @param identity - exact Community Skill release identity.
   * @param signal - cancellation forwarded to upstream requests.
   * @returns upstream artifact stream with Host-owned download metadata.
   */
  async download(identity: CommunitySkillIdentity, signal?: AbortSignal): Promise<CommunitySkillDownload> {
    this.#assertRegistry(identity)
    const release = this.#releasePath(identity)
    const [version, resolved] = await Promise.all([
      this.#json(`/api/web/skills/${release.exact}`, signal).then(parseVersion),
      this.#json(`/api/web/skills/${release.skill}/resolve?version=${encodeURIComponent(identity.version)}`, signal).then(parseResolve),
    ])
    assertResolvedIdentity(identity, resolved)
    if (version.version !== identity.version || version.canonicalName === undefined) {
      throw invalidResponse(`SkillHub version changed while downloading ${identity.namespace}/${identity.slug}@${identity.version}`)
    }
    const response = await this.#response(`/api/web/skills/${release.exact}/download`, 'application/zip', signal)
    if (response.body === null) throw invalidResponse('SkillHub exact release download returned no body')
    const body = await verifiedZipBody(response.body)
    const contentLength = parseContentLength(response.headers.get('content-length'))
    return {
      filename: `${safeFilenamePart(version.canonicalName)}-${safeFilenamePart(identity.version)}.zip`,
      contentType: response.headers.get('content-type') ?? 'application/zip',
      ...(contentLength === undefined ? {} : { contentLength }),
      body,
    }
  }

  #assertRegistry(identity: CommunitySkillIdentity): void {
    if (identity.registryInstanceId !== this.options.registryInstanceId) {
      throw new RangeError(`skill-marketplace: unknown Registry Instance ${identity.registryInstanceId}`)
    }
  }

  #releasePath(identity: CommunitySkillIdentity): { skill: string; exact: string } {
    const skill = `${encodeURIComponent(identity.namespace)}/${encodeURIComponent(identity.slug)}`
    return { skill, exact: `${skill}/versions/${encodeURIComponent(identity.version)}` }
  }

  async #load(
    request: { query: string; label: string; sort: string; page: number; pageSize: number },
    signal?: AbortSignal,
  ): Promise<Omit<CommunitySkillPage, 'freshness' | 'lastSuccessfulAt'>> {
    const { page, pageSize } = request
    const params = new URLSearchParams({ page: String(page), size: String(pageSize) })
    if (request.query !== '') params.set('q', request.query)
    if (request.label !== '') params.append('label', request.label)
    if (request.sort !== '') params.set('sort', request.sort)

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
    const response = await this.#response(path, 'application/json', signal)
    const url = new URL(path.replace(/^\//, ''), this.#baseUrl)
    try {
      return await response.json()
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason
      throw invalidResponse(`SkillHub returned invalid JSON for ${url.pathname}`, error)
    }
  }

  async #text(path: string, accept: string, signal?: AbortSignal): Promise<string> {
    const response = await this.#response(path, accept, signal)
    try {
      return await boundedText(response, this.options.skillMarkdownMaxBytes)
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason
      throw invalidResponse(`SkillHub returned unreadable text for ${new URL(path, this.#baseUrl).pathname}`, error)
    }
  }

  async #response(path: string, accept: string, signal?: AbortSignal): Promise<Response> {
    const url = new URL(path.replace(/^\//, ''), this.#baseUrl)
    let response!: Response
    for (let attempt = 0; attempt <= this.options.rateLimitRetries; attempt += 1) {
      try {
        response = await this.options.fetch(url, {
          headers: { accept },
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (error) {
        if (signal?.aborted === true) throw signal.reason
        throw new SkillMarketplaceError(`SkillHub request failed for ${url.pathname}`, 'SKILL_MARKETPLACE_UPSTREAM', { cause: error })
      }
      if (response.status !== 429 || attempt === this.options.rateLimitRetries) break
      await response.body?.cancel()
      await this.options.sleep(this.options.rateLimitBackoffMs * (2 ** attempt), signal)
      if (signal?.aborted === true) throw signal.reason
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new SkillMarketplaceError(
        `SkillHub request failed for ${url.pathname} with HTTP ${response.status}`,
        'SKILL_MARKETPLACE_UPSTREAM',
      )
    }
    return response
  }

  async #versions(skill: string, signal?: AbortSignal): Promise<readonly CommunitySkillVersion[]> {
    const pageSize = this.options.pageSizeLimit
    const first = parseVersions(await this.#json(`/api/web/skills/${skill}/versions?page=0&size=${pageSize}`, signal))
    const items = [...first.items]
    for (let page = 1; page * first.pageSize < first.total; page += 1) {
      const next = parseVersions(await this.#json(
        `/api/web/skills/${skill}/versions?page=${page}&size=${pageSize}`,
        signal,
      ))
      if (next.page !== page || next.pageSize !== first.pageSize || next.total !== first.total) {
        throw invalidResponse('SkillHub version pagination changed while loading release detail')
      }
      items.push(...next.items)
    }
    return items
  }
}

function cacheAge(now: Date, entry: CacheEntry): number {
  return Math.max(0, now.getTime() - entry.successfulAt)
}

function cacheValue(entry: CacheEntry, freshness: CommunitySkillPage['freshness']): CommunitySkillPage {
  return { ...entry.value, freshness, lastSuccessfulAt: new Date(entry.successfulAt).toISOString() }
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
    '/api/web/skills/{namespace}/{slug}/versions',
    '/api/web/skills/{namespace}/{slug}/versions/{version}/files',
    '/api/web/skills/{namespace}/{slug}/versions/{version}/file',
    '/api/web/skills/{namespace}/{slug}/resolve',
    '/api/web/skills/{namespace}/{slug}/versions/{version}/download',
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
    SkillDetailResponse: ['slug', 'displayName', 'summary', 'ownerDisplayName', 'namespace', 'labels', 'starCount', 'downloadCount'],
    SkillVersionDetailResponse: ['version', 'publishedAt', 'parsedMetadataJson'],
    SkillVersionResponse: ['version', 'publishedAt', 'downloadAvailable'],
    SkillFileResponse: ['filePath', 'fileSize', 'contentType', 'sha256'],
    ResolveVersionResponse: ['namespace', 'slug', 'version', 'matched', 'downloadUrl'],
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
    displayName: stringField(data, 'displayName'),
    summary: stringField(data, 'summary'),
    ownerDisplayName: stringField(data, 'ownerDisplayName'),
    starCount: nonNegativeIntegerField(data, 'starCount'),
    downloadCount: nonNegativeIntegerField(data, 'downloadCount'),
    labels: arrayField(data, 'labels').map((value, index) => stringField(record(value, `skill label ${index}`), 'slug')),
  }
}

function parseVersion(input: unknown): SkillVersionDetail {
  const data = envelopeData(input, 'version detail')
  const publishedAt = data.publishedAt
  if (publishedAt !== undefined && publishedAt !== null && typeof publishedAt !== 'string') {
    throw invalidResponse('SkillHub version detail field "publishedAt" must be a string or null')
  }
  const metadata = parseMetadata(stringField(data, 'parsedMetadataJson'))
  return {
    version: stringField(data, 'version'),
    ...(typeof publishedAt === 'string' ? { publishedAt } : {}),
    ...metadata,
  }
}

function parseMetadata(input: string): { canonicalName?: string; examplePrompt?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(input) as unknown
  } catch (error) {
    throw invalidResponse('SkillHub release metadata is invalid JSON', error)
  }
  const value = record(parsed, 'release metadata')
  const name = value.name
  if (name !== undefined && typeof name !== 'string') throw invalidResponse('SkillHub release metadata field "name" must be a string')
  const metadataValue = value.metadata
  if (metadataValue === undefined) return typeof name === 'string' ? { canonicalName: name } : {}
  const metadata = record(metadataValue, 'release metadata field "metadata"')
  const examplePrompt = metadata.examplePrompt
  if (examplePrompt !== undefined && typeof examplePrompt !== 'string') {
    throw invalidResponse('SkillHub release metadata field "metadata.examplePrompt" must be a string')
  }
  return {
    ...(typeof name === 'string' ? { canonicalName: name } : {}),
    ...(typeof examplePrompt === 'string' ? { examplePrompt } : {}),
  }
}

interface VersionPage {
  readonly items: readonly CommunitySkillVersion[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
}

function parseVersions(input: unknown): VersionPage {
  const data = envelopeData(input, 'version list')
  const items = arrayField(data, 'items').map((value, index) => {
    const item = record(value, `version list item ${index}`)
    const publishedAt = item.publishedAt
    if (publishedAt !== undefined && publishedAt !== null && typeof publishedAt !== 'string') {
      throw invalidResponse('SkillHub version list field "publishedAt" must be a string or null')
    }
    return {
      version: stringField(item, 'version'),
      ...(typeof publishedAt === 'string' ? { publishedAt } : {}),
      downloadAvailable: booleanField(item, 'downloadAvailable'),
    }
  })
  return {
    items,
    total: nonNegativeIntegerField(data, 'total'),
    page: nonNegativeIntegerField(data, 'page'),
    pageSize: positiveIntegerField(data, 'size'),
  }
}

function parseFiles(input: unknown): readonly CommunitySkillFile[] {
  return arrayValue(envelopeDataValue(input, 'release files'), 'release files').map((value, index) => {
    const file = record(value, `release file ${index}`)
    return {
      path: stringField(file, 'filePath'),
      size: nonNegativeIntegerField(file, 'fileSize'),
      contentType: stringField(file, 'contentType'),
      sha256: stringField(file, 'sha256'),
    }
  })
}

interface ResolvedRelease {
  readonly namespace: string
  readonly slug: string
  readonly version: string
  readonly matched: boolean
}

function parseResolve(input: unknown): ResolvedRelease {
  const data = envelopeData(input, 'resolved release')
  return {
    namespace: stringField(data, 'namespace'),
    slug: stringField(data, 'slug'),
    version: stringField(data, 'version'),
    matched: booleanField(data, 'matched'),
  }
}

function assertExactIdentity(
  identity: CommunitySkillIdentity,
  detail: SkillDetail,
  version: SkillVersionDetail,
  resolved: ResolvedRelease,
): void {
  if (detail.namespace !== identity.namespace || detail.slug !== identity.slug || version.version !== identity.version) {
    throw invalidResponse(`SkillHub identity changed while loading ${identity.namespace}/${identity.slug}@${identity.version}`)
  }
  assertResolvedIdentity(identity, resolved)
}

function assertResolvedIdentity(identity: CommunitySkillIdentity, resolved: ResolvedRelease): void {
  if (!resolved.matched
    || resolved.namespace !== identity.namespace
    || resolved.slug !== identity.slug
    || resolved.version !== identity.version) {
    throw invalidResponse(`SkillHub resolved a different release for ${identity.namespace}/${identity.slug}@${identity.version}`)
  }
}

function assertInstallIdentity(identity: CommunitySkillIdentity): void {
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
  const version = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
  if (!identifier.test(identity.namespace) || !identifier.test(identity.slug) || !version.test(identity.version)) {
    throw invalidResponse('SkillHub release identity cannot be represented as a safe SkillHub CLI command')
  }
}

function safeFilenamePart(input: string): string {
  const value = input.replaceAll(/[^A-Za-z0-9._-]/g, '_')
  if (value === '' || value === '.' || value === '..') throw invalidResponse('SkillHub release metadata has an invalid canonical name')
  return value
}

function parseContentLength(input: string | null): number | undefined {
  if (input === null) return undefined
  const value = Number(input)
  if (!Number.isSafeInteger(value) || value < 0) throw invalidResponse('SkillHub download Content-Length must be a non-negative safe integer')
  return value
}

async function boundedText(response: Response, maximumBytes: number): Promise<string> {
  const declaredBytes = parseContentLength(response.headers.get('content-length'))
  if (declaredBytes !== undefined && declaredBytes > maximumBytes) {
    await response.body?.cancel()
    throw invalidResponse(`SkillHub SKILL.md exceeds the configured ${maximumBytes}-byte limit`)
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  while (true) {
    const result = await reader.read()
    if (result.done) return text + decoder.decode()
    bytes += result.value.byteLength
    if (bytes > maximumBytes) {
      await reader.cancel()
      throw invalidResponse(`SkillHub SKILL.md exceeds the configured ${maximumBytes}-byte limit`)
    }
    text += decoder.decode(result.value, { stream: true })
  }
}

async function verifiedZipBody(body: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader()
  const initial: Uint8Array[] = []
  let initialBytes = 0
  while (initialBytes < 4) {
    const result = await reader.read()
    if (result.done) break
    initial.push(result.value)
    initialBytes += result.value.byteLength
  }
  const signature = new Uint8Array(initialBytes)
  let offset = 0
  for (const chunk of initial) {
    signature.set(chunk, offset)
    offset += chunk.byteLength
  }
  const valid = signature.byteLength >= 4
    && signature[0] === 0x50
    && signature[1] === 0x4b
    && ((signature[2] === 0x03 && signature[3] === 0x04)
      || (signature[2] === 0x05 && signature[3] === 0x06)
      || (signature[2] === 0x07 && signature[3] === 0x08))
  if (!valid) {
    await reader.cancel()
    throw invalidResponse('SkillHub exact release download is not a ZIP artifact')
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of initial) controller.enqueue(chunk)
    },
    async pull(controller) {
      const result = await reader.read()
      if (result.done) controller.close()
      else controller.enqueue(result.value)
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })
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

function booleanField(input: Record<string, unknown>, key: string): boolean {
  const value = input[key]
  if (typeof value !== 'boolean') throw invalidResponse(`SkillHub field "${key}" must be a boolean`)
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
