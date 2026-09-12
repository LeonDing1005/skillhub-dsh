import { createHash, type Hash } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { Unzip, UnzipInflate, type UnzipFile } from 'fflate'
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
  readonly versionCountLimit: number
  readonly zipDirectoryMaxBytes: number
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
    const [version, resolved, files] = await Promise.all([
      this.#json(`/api/web/skills/${release.exact}`, signal).then(parseVersion),
      this.#json(`/api/web/skills/${release.skill}/resolve?version=${encodeURIComponent(identity.version)}`, signal).then(parseResolve),
      this.#json(`/api/web/skills/${release.exact}/files`, signal).then(parseFiles),
    ])
    assertResolvedIdentity(identity, resolved)
    if (version.version !== identity.version || version.canonicalName === undefined) {
      throw invalidResponse(`SkillHub version changed while downloading ${identity.namespace}/${identity.slug}@${identity.version}`)
    }
    const response = await this.#response(`/api/web/skills/${release.exact}/download`, 'application/zip', signal)
    try {
      if (response.body === null) throw invalidResponse('SkillHub exact release download returned no body')
      const contentLength = parseContentLength(response.headers.get('content-length'))
      const filename = `${safeFilenamePart(version.canonicalName)}-${safeFilenamePart(identity.version)}.zip`
      return {
        filename,
        contentType: response.headers.get('content-type') ?? 'application/zip',
        ...(contentLength === undefined ? {} : { contentLength }),
        body: verifiedZipBody(response.body, files, contentLength, this.options.zipDirectoryMaxBytes),
      }
    } catch (error) {
      await response.body?.cancel(error)
      throw error
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
    if (first.page !== 0) throw invalidResponse('SkillHub version pagination did not begin at page zero')
    if (first.total > this.options.versionCountLimit) {
      throw invalidResponse(`SkillHub version count exceeds the configured ${this.options.versionCountLimit}-item limit`)
    }
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
    if (items.length !== first.total) throw invalidResponse('SkillHub version pagination returned an incomplete result')
    if (new Set(items.map(item => item.version)).size !== items.length) {
      throw invalidResponse('SkillHub version pagination returned duplicate releases')
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
  if (typeof name === 'string' && name.trim() === '') throw invalidResponse('SkillHub release metadata field "name" must not be blank')
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
  let declaredBytes: number | undefined
  try {
    declaredBytes = parseContentLength(response.headers.get('content-length'))
  } catch (error) {
    await response.body?.cancel(error)
    throw error
  }
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

const ZIP_EOCD_MAX_BYTES = 65_557
const ZIP_LOCAL_HEADER_SCAN_BYTES = 131_103
const ZIP_SCAN_CHUNK_BYTES = 64 * 1024
const ZIP_UNICODE_PATH_EXTRA_FIELD = 0x7075

interface ExpectedZipFile {
  readonly size: number
  readonly sha256: string
}

interface ZipLocalHeader {
  readonly offset: number
  readonly compression: number
  readonly flags: number
  readonly crc32: number
  readonly compressedSize: number
  readonly uncompressedSize: number
}

function verifiedZipBody(
  body: ReadableStream<Uint8Array>,
  files: readonly CommunitySkillFile[],
  contentLength: number | undefined,
  directoryMaxBytes: number,
): ReadableStream<Uint8Array> {
  const expected = new Map<string, ExpectedZipFile>()
  for (const file of files) {
    if (file.path === '' || expected.has(file.path) || !/^[a-f0-9]{64}$/i.test(file.sha256)) {
      throw invalidResponse('SkillHub release file metadata is not safe for artifact verification')
    }
    expected.set(file.path, { size: file.size, sha256: file.sha256.toLowerCase() })
  }
  const reader = body.getReader()
  const seen = new Set<string>()
  const decodedCrcs = new Map<string, number>()
  const localHeaders = new Map<string, ZipLocalHeader>()
  let failure: SkillMarketplaceError | undefined
  let byteCount = 0
  const tail = new ByteTail(directoryMaxBytes + ZIP_EOCD_MAX_BYTES)
  let localScanTail = new Uint8Array()
  const fail = (message: string, cause?: unknown): void => {
    failure ??= invalidResponse(message, cause)
  }
  const unzip = new Unzip((entry) => { verifyZipEntry(entry, expected, seen, decodedCrcs, fail) })
  unzip.register(UnzipInflate)

  const consume = (chunk: Uint8Array, final: boolean): void => {
    byteCount += chunk.byteLength
    tail.push(chunk)
    for (let offset = 0; offset < chunk.byteLength; offset += ZIP_SCAN_CHUNK_BYTES) {
      const part = chunk.subarray(offset, offset + ZIP_SCAN_CHUNK_BYTES)
      localScanTail = scanZipLocalHeaders(localScanTail, part, byteCount - chunk.byteLength + offset, expected, localHeaders, fail)
      try {
        unzip.push(part, false)
      } catch (error) {
        fail('SkillHub exact release download is not a valid ZIP artifact', error)
      }
    }
    if (final) {
      try {
        unzip.push(new Uint8Array(), true)
      } catch (error) {
        fail('SkillHub exact release download is not a valid ZIP artifact', error)
      }
    }
    if (!final) return
    if (contentLength !== undefined && byteCount !== contentLength) {
      fail('SkillHub exact release download length does not match Content-Length')
    }
    verifyZipEnd(tail.bytes(), byteCount, expected, localHeaders, decodedCrcs, directoryMaxBytes, fail)
    if (seen.size !== expected.size) fail('SkillHub exact release ZIP is missing recorded files')
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          consume(new Uint8Array(), true)
          if (failure !== undefined) throw failure
          controller.close()
          return
        }
        consume(result.value, false)
        if (failure !== undefined) throw failure
        controller.enqueue(result.value)
      } catch (error) {
        await reader.cancel(error).catch(() => {})
        controller.error(error instanceof SkillMarketplaceError
          ? error
          : invalidResponse('SkillHub exact release ZIP verification failed', error))
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })
}

function verifyZipEntry(
  entry: UnzipFile,
  expected: ReadonlyMap<string, ExpectedZipFile>,
  seen: Set<string>,
  decodedCrcs: Map<string, number>,
  fail: (message: string, cause?: unknown) => void,
): void {
  const recorded = expected.get(entry.name)
  if (recorded === undefined || seen.has(entry.name)) {
    fail('SkillHub exact release ZIP contains an unexpected or duplicate file')
    entry.ondata = () => {}
    entry.start()
    return
  }
  seen.add(entry.name)
  let bytes = 0
  let checksum = 0
  let hash: Hash | undefined = createHash('sha256')
  entry.ondata = (error, data, final) => {
    if (error !== null) fail('SkillHub exact release ZIP entry could not be decoded', error)
    bytes += data.byteLength
    checksum = crc32(data, checksum)
    hash?.update(data)
    if (!final) return
    const digest = hash?.digest('hex')
    hash = undefined
    if (bytes !== recorded.size || digest !== recorded.sha256) {
      fail('SkillHub exact release ZIP file does not match recorded size and SHA-256')
    }
    decodedCrcs.set(entry.name, checksum)
  }
  try {
    entry.start()
  } catch (error) {
    fail('SkillHub exact release ZIP uses an unsupported compression method', error)
  }
}

function scanZipLocalHeaders(
  previous: Uint8Array,
  chunk: Uint8Array,
  chunkOffset: number,
  expected: ReadonlyMap<string, ExpectedZipFile>,
  headers: Map<string, ZipLocalHeader>,
  fail: (message: string, cause?: unknown) => void,
): Uint8Array<ArrayBuffer> {
  const combined = new Uint8Array(previous.byteLength + chunk.byteLength)
  combined.set(previous)
  combined.set(chunk, previous.byteLength)
  const baseOffset = chunkOffset - previous.byteLength
  for (let index = 0; index <= combined.byteLength - 30; index += 1) {
    if (!zipSignature(combined, index, 0x03, 0x04)) continue
    const view = new DataView(combined.buffer, combined.byteOffset + index, combined.byteLength - index)
    const nameBytes = view.getUint16(26, true)
    const extraBytes = view.getUint16(28, true)
    const extraStart = index + 30 + nameBytes
    if (extraStart + extraBytes > combined.byteLength) continue
    let name: string
    try {
      name = decodeZipName(combined.subarray(index + 30, index + 30 + nameBytes))
    } catch (error) {
      fail('SkillHub exact release ZIP contains an invalid UTF-8 local filename', error)
      continue
    }
    if (!expected.has(name)) continue
    if (hasUnsupportedZipExtraField(combined, extraStart, extraBytes)) {
      fail('SkillHub exact release ZIP local header contains invalid or path-overriding extra fields')
      continue
    }
    const header = {
      offset: baseOffset + index,
      compression: view.getUint16(8, true),
      flags: view.getUint16(6, true),
      crc32: view.getUint32(14, true),
      compressedSize: view.getUint32(18, true),
      uncompressedSize: view.getUint32(22, true),
    }
    const existing = headers.get(name)
    if (existing !== undefined && existing.offset !== header.offset) {
      fail('SkillHub exact release ZIP contains duplicate local headers for a recorded file')
      continue
    }
    headers.set(name, header)
  }
  return combined.slice(-ZIP_LOCAL_HEADER_SCAN_BYTES)
}

class ByteTail {
  readonly #buffer: Uint8Array
  #length = 0
  #start = 0

  constructor(maximumBytes: number) {
    this.#buffer = new Uint8Array(maximumBytes)
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength >= this.#buffer.byteLength) {
      this.#buffer.set(chunk.subarray(chunk.byteLength - this.#buffer.byteLength))
      this.#length = this.#buffer.byteLength
      this.#start = 0
      return
    }
    const overflow = Math.max(0, this.#length + chunk.byteLength - this.#buffer.byteLength)
    this.#start = (this.#start + overflow) % this.#buffer.byteLength
    this.#length = Math.min(this.#buffer.byteLength, this.#length + chunk.byteLength)
    const writeAt = (this.#start + this.#length - chunk.byteLength) % this.#buffer.byteLength
    const first = Math.min(chunk.byteLength, this.#buffer.byteLength - writeAt)
    this.#buffer.set(chunk.subarray(0, first), writeAt)
    this.#buffer.set(chunk.subarray(first), 0)
  }

  bytes(): Uint8Array<ArrayBuffer> {
    const value = new Uint8Array(this.#length)
    const first = Math.min(this.#length, this.#buffer.byteLength - this.#start)
    value.set(this.#buffer.subarray(this.#start, this.#start + first))
    value.set(this.#buffer.subarray(0, this.#length - first), first)
    return value
  }
}

function verifyZipEnd(
  tail: Uint8Array,
  totalBytes: number,
  expected: ReadonlyMap<string, ExpectedZipFile>,
  localHeaders: ReadonlyMap<string, ZipLocalHeader>,
  decodedCrcs: ReadonlyMap<string, number>,
  directoryMaxBytes: number,
  fail: (message: string) => void,
): void {
  for (let index = tail.byteLength - 22; index >= 0; index -= 1) {
    if (tail[index] !== 0x50 || tail[index + 1] !== 0x4b || tail[index + 2] !== 0x05 || tail[index + 3] !== 0x06) continue
    const view = new DataView(tail.buffer, tail.byteOffset + index, tail.byteLength - index)
    const commentBytes = view.getUint16(20, true)
    if (index + 22 + commentBytes !== tail.byteLength) continue
    const disk = view.getUint16(4, true)
    const centralDisk = view.getUint16(6, true)
    const diskEntries = view.getUint16(8, true)
    const totalEntries = view.getUint16(10, true)
    const centralSize = view.getUint32(12, true)
    const centralOffset = view.getUint32(16, true)
    const absoluteOffset = totalBytes - tail.byteLength + index
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries || totalEntries !== expected.size
      || centralOffset + centralSize !== absoluteOffset) {
      fail('SkillHub exact release ZIP central directory does not match recorded files')
      return
    }
    if (centralSize > directoryMaxBytes) {
      fail(`SkillHub exact release ZIP central directory exceeds the configured ${directoryMaxBytes}-byte limit`)
      return
    }
    const centralIndex = tail.byteLength - (totalBytes - centralOffset)
    if (centralIndex < 0) {
      fail('SkillHub exact release ZIP central directory exceeds the retained verification window')
      return
    }
    verifyCentralEntries(tail, centralIndex, index, expected, localHeaders, decodedCrcs, fail)
    return
  }
  fail('SkillHub exact release ZIP is missing a valid central directory')
}

function verifyCentralEntries(
  bytes: Uint8Array,
  start: number,
  end: number,
  expected: ReadonlyMap<string, ExpectedZipFile>,
  localHeaders: ReadonlyMap<string, ZipLocalHeader>,
  decodedCrcs: ReadonlyMap<string, number>,
  fail: (message: string) => void,
): void {
  const seen = new Set<string>()
  let cursor = start
  while (cursor < end) {
    if (cursor + 46 > end || !zipSignature(bytes, cursor, 0x01, 0x02)) {
      fail('SkillHub exact release ZIP contains an invalid central directory entry')
      return
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, end - cursor)
    const flags = view.getUint16(8, true)
    const compression = view.getUint16(10, true)
    const declaredCrc32 = view.getUint32(16, true)
    const compressedSize = view.getUint32(20, true)
    const uncompressedSize = view.getUint32(24, true)
    const nameBytes = view.getUint16(28, true)
    const extraBytes = view.getUint16(30, true)
    const commentBytes = view.getUint16(32, true)
    const disk = view.getUint16(34, true)
    const externalAttributes = view.getUint32(38, true)
    const localOffset = view.getUint32(42, true)
    const next = cursor + 46 + nameBytes + extraBytes + commentBytes
    if (next > end) {
      fail('SkillHub exact release ZIP central directory entry is truncated')
      return
    }
    let name: string
    try {
      name = decodeZipName(bytes.subarray(cursor + 46, cursor + 46 + nameBytes))
    } catch {
      fail('SkillHub exact release ZIP contains an invalid UTF-8 central filename')
      return
    }
    if (hasUnsupportedZipExtraField(bytes, cursor + 46 + nameBytes, extraBytes)) {
      fail('SkillHub exact release ZIP central entry contains invalid or path-overriding extra fields')
      return
    }
    const recorded = expected.get(name)
    const local = localHeaders.get(name)
    const unixType = (externalAttributes >>> 16) & 0xf000
    const directory = name.endsWith('/') || (externalAttributes & 0x10) !== 0 || unixType === 0x4000
    const specialFile = unixType !== 0 && unixType !== 0x8000
    if (recorded === undefined) {
      fail('SkillHub exact release ZIP central filename is not in the recorded file list')
      return
    }
    if (local === undefined) {
      fail('SkillHub exact release ZIP central filename has no matching local header')
      return
    }
    if (seen.has(name) || disk !== 0 || (flags & 0x01) !== 0 || (compression !== 0 && compression !== 8)
      || directory || specialFile) {
      fail('SkillHub exact release ZIP central entry has unsupported or duplicate file metadata')
      return
    }
    if (flags !== local.flags || compression !== local.compression || localOffset !== local.offset) {
      fail('SkillHub exact release ZIP central entry does not reference its verified local header')
      return
    }
    const dataDescriptor = (flags & 0x08) !== 0
    if (decodedCrcs.get(name) !== declaredCrc32
      || (!dataDescriptor && (local.crc32 !== declaredCrc32
      || local.compressedSize !== compressedSize || local.uncompressedSize !== uncompressedSize))
      || (dataDescriptor && ((local.crc32 !== 0 && local.crc32 !== declaredCrc32)
        || (local.compressedSize !== 0 && local.compressedSize !== compressedSize)
        || (local.uncompressedSize !== 0 && local.uncompressedSize !== uncompressedSize)))
      || uncompressedSize !== recorded.size) {
      fail('SkillHub exact release ZIP central entry does not match its local header or recorded file size')
      return
    }
    seen.add(name)
    cursor = next
  }
  if (cursor !== end || seen.size !== expected.size || localHeaders.size !== expected.size) {
    fail('SkillHub exact release ZIP central directory is incomplete')
  }
}

function hasUnsupportedZipExtraField(bytes: Uint8Array, start: number, length: number): boolean {
  const end = start + length
  let cursor = start
  while (cursor < end) {
    if (cursor + 4 > end) return true
    const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, end - cursor)
    const id = view.getUint16(0, true)
    const size = view.getUint16(2, true)
    cursor += 4
    if (cursor + size > end || id === ZIP_UNICODE_PATH_EXTRA_FIELD) return true
    cursor += size
  }
  return cursor !== end
}

function zipSignature(bytes: Uint8Array, index: number, third: number, fourth: number): boolean {
  return bytes[index] === 0x50 && bytes[index + 1] === 0x4b
    && bytes[index + 2] === third && bytes[index + 3] === fourth
}

function decodeZipName(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
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
