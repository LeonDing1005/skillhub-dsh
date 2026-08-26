/**
 * Host-only managed Community Skill package admission and immutable storage.
 *
 * The package validates downloaded ZIPs in a private staging tree and publishes
 * `content/` plus `receipt.json` through one directory rename. It neither
 * registers a Cordis service nor contributes a callable skill.
 *
 * @module @deepseek-ai/dsh-skill-installation
 */

import { createHash, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, join, posix, resolve } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { parseSkillDocument } from '@deepseek-ai/dsh-skill-filesystem'
import { extractSkillArchive } from './archive.ts'
import { fail, ManagedSkillAdmissionError } from './error.ts'
import { computeSkillHubFingerprint } from './fingerprint.ts'
import { isSafeManagedPath } from './path.ts'
import type {
  CommunitySkillIdentity,
  ExpectedSkillFile,
  ManagedSkillAdmissionLimits,
  ManagedSkillReceipt,
  ManagedSkillRelease,
  ManagedSkillStoreOptions,
  RegistryInstanceId,
  VerifiedSkillFile,
} from './types.ts'

export { ManagedSkillAdmissionError } from './error.ts'
export { computeSkillHubFingerprint } from './fingerprint.ts'
export type {
  CommunitySkillIdentity,
  ExpectedSkillFile,
  ManagedSkillAdmissionErrorCode,
  ManagedSkillAdmissionLimits,
  ManagedSkillReceipt,
  ManagedSkillRelease,
  ManagedSkillStoreOptions,
  RegistryInstanceId,
  VerifiedSkillFile,
} from './types.ts'

const RECEIPT_FILE = 'receipt.json'
const CONTENT_DIRECTORY = 'content'
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/

/**
 * Construct a Registry Instance id after configuration validation.
 * @param value - validated deployment-owned identifier.
 * @returns the branded Registry Instance identifier.
 */
export const registryInstanceId = (value: string): RegistryInstanceId => value as RegistryInstanceId

interface NormalizedRelease extends Omit<ManagedSkillRelease, 'manifest' | 'sourceServer'> {
  readonly manifest: readonly ExpectedSkillFile[]
  readonly sourceServer: string
}

/** Host-internal store that admits immutable managed package versions. */
export class ManagedSkillStore {
  /** Versioned storage root containing only committed packages and private staging. */
  readonly root: string
  private readonly packagesRoot: string
  private readonly stagingRoot: string
  private readonly limits: ManagedSkillAdmissionLimits
  private readonly now: () => Date

  /**
   * Create a store over one deployment-owned root.
   * @param options - explicit storage root, admission limits, and optional clock.
   */
  constructor(options: ManagedSkillStoreOptions) {
    validateLimits(options.limits)
    this.root = join(resolve(options.root), 'v1')
    this.packagesRoot = join(this.root, 'packages')
    this.stagingRoot = join(this.root, 'staging')
    this.limits = Object.freeze({ ...options.limits })
    this.now = options.now ?? (() => new Date())
  }

  /**
   * Admit one exact Community Skill release. Cancellation before publication
   * removes staging and rethrows the signal reason; cancellation after
   * publication does not retract a completed admission. An identical release
   * returns its verified durable receipt without decoding the artifact again.
   * @param release - exact remote identity, manifest, fingerprint, and ZIP bytes.
   * @param signal - optional transfer and extraction cancellation.
   * @returns the existing or newly committed immutable receipt.
   * @throws {@link ManagedSkillAdmissionError} for typed rejection and storage failures.
   */
  async admit(release: ManagedSkillRelease, signal?: AbortSignal): Promise<ManagedSkillReceipt> {
    signal?.throwIfAborted()
    if (release.manifest.length > this.limits.maxEntryCount) {
      fail('Managed Community Skill manifest exceeds the configured archive entry limit.', 'TOO_MANY_FILES')
    }
    const normalized = normalizeRelease(release)
    let completed: ManagedSkillReceipt | undefined
    try {
      await this.prepareStorage()
      return await withFileLock(join(this.root, 'admission'), async () => {
        signal?.throwIfAborted()
        const finalPath = join(this.packagesRoot, packageKey(normalized))
        const existing = await readReceiptIfPresent(finalPath)
        if (existing !== undefined) {
          completed = assertIdempotent(existing, normalized)
          return completed
        }
        await this.assertCanonicalNameAvailable(normalized)
        completed = await this.stageAndCommit(normalized, finalPath, signal)
        return completed
      })
    } catch (error) {
      if (completed !== undefined) {
        process.emitWarning('Managed Community Skill admission completed, but its writer lock could not be released.', {
          code: 'DSH_MANAGED_SKILL_LOCK_RELEASE',
          detail: String(error),
        })
        return completed
      }
      signal?.throwIfAborted()
      if (error instanceof ManagedSkillAdmissionError) throw error
      fail('Managed Community Skill admission could not commit.', 'COMMIT_FAILED', error)
    }
  }

  private async prepareStorage(): Promise<void> {
    await ensurePrivateDirectory(this.root)
    await ensurePrivateDirectory(this.packagesRoot)
    await ensurePrivateDirectory(this.stagingRoot)
  }

  private async assertCanonicalNameAvailable(release: NormalizedRelease): Promise<void> {
    const entries = await readdir(this.packagesRoot, { withFileTypes: true, encoding: 'utf8' })
    for (const entry of entries) {
      if (!entry.isDirectory()) fail(`Managed package store contains unsupported entry "${entry.name}".`, 'STORE_CORRUPT')
      const receipt = await readReceipt(join(this.packagesRoot, entry.name))
      if (receipt.canonicalName === release.canonicalName && !sameRemoteIdentity(receipt.identity, release.identity)) {
        fail(
          `Managed skill name "${release.canonicalName}" is already owned by ${receipt.identity.namespace}/${receipt.identity.slug}.`,
          'CANONICAL_NAME_CONFLICT',
        )
      }
    }
  }

  private async stageAndCommit(
    release: NormalizedRelease,
    finalPath: string,
    signal?: AbortSignal,
  ): Promise<ManagedSkillReceipt> {
    const stagingId = randomUUID()
    const staging = join(this.stagingRoot, stagingId)
    const prepared = join(this.packagesRoot, `.admitting-${stagingId}`)
    const content = join(staging, CONTENT_DIRECTORY)
    await mkdir(content, { recursive: true, mode: 0o700 })
    let committed = false
    let cleanupPath = staging
    try {
      const extracted = await extractSkillArchive(release.artifact, content, this.limits, signal)
      assertManifest(extracted.files, release.manifest)
      const fingerprint = computeSkillHubFingerprint(extracted.files)
      const skill = await parseStagedSkill(content)
      if (skill.name !== release.canonicalName) {
        fail(
          `Community Skill package name "${skill.name}" does not match catalog name "${release.canonicalName}".`,
          'IDENTITY_MISMATCH',
        )
      }
      const installedAt = this.now().toISOString()
      const receipt: ManagedSkillReceipt = {
        formatVersion: 1,
        identity: { ...release.identity },
        adapter: release.adapter,
        sourceServer: release.sourceServer,
        canonicalName: release.canonicalName,
        version: release.version,
        manifest: extracted.files.map(file => ({ ...file })),
        fingerprint,
        installedAt,
        enabled: true,
        managedLocation: join(finalPath, CONTENT_DIRECTORY),
      }
      await writeFile(join(staging, RECEIPT_FILE), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      await freezeTreeContents(staging)
      signal?.throwIfAborted()
      await rename(staging, prepared)
      cleanupPath = prepared
      await chmod(prepared, 0o555)
      signal?.throwIfAborted()
      await rename(prepared, finalPath)
      committed = true
      return freezeReceipt(receipt)
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof ManagedSkillAdmissionError) throw error
      return fail('Managed Community Skill package could not be staged and committed.', 'COMMIT_FAILED', error)
    } finally {
      if (!committed) await removeStaging(cleanupPath)
    }
  }
}

function normalizeRelease(release: ManagedSkillRelease): NormalizedRelease {
  for (const [field, value] of [
    ['registryInstanceId', release.identity.registryInstanceId],
    ['namespace', release.identity.namespace],
    ['slug', release.identity.slug],
    ['adapter', release.adapter],
    ['canonicalName', release.canonicalName],
    ['version', release.version],
  ] as const) {
    if (value === '' || value.trim() !== value || value.includes('\0')) {
      fail(`Managed Community Skill ${field} must be a non-empty trimmed string.`, 'INVALID_REQUEST')
    }
  }
  let sourceServer: string
  try {
    const url = new URL(release.sourceServer)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') throw new Error('unsupported URL')
    sourceServer = url.toString()
  } catch (error) {
    fail('Managed Community Skill sourceServer must be an HTTP(S) URL without credentials.', 'INVALID_REQUEST', error)
  }
  if (!FINGERPRINT_PATTERN.test(release.fingerprint)) {
    fail('Managed Community Skill fingerprint must be a lowercase sha256 digest.', 'INVALID_REQUEST')
  }
  if (release.artifact.byteLength === 0) fail('Managed Community Skill artifact must not be empty.', 'INVALID_REQUEST')
  const manifest = normalizeManifest(release.manifest)
  if (computeSkillHubFingerprint(manifest) !== release.fingerprint) {
    fail('Managed Community Skill manifest does not produce the resolved fingerprint.', 'FINGERPRINT_MISMATCH')
  }
  return { ...release, sourceServer, manifest }
}

function normalizeManifest(manifest: readonly ExpectedSkillFile[]): readonly ExpectedSkillFile[] {
  if (manifest.length === 0) fail('Managed Community Skill manifest must not be empty.', 'INVALID_REQUEST')
  const seen = new Set<string>()
  const normalized = manifest.map((file): ExpectedSkillFile => {
    validateManifestPath(file.path)
    if (seen.has(file.path)) fail(`Managed Community Skill manifest repeats path "${file.path}".`, 'INVALID_REQUEST')
    seen.add(file.path)
    if (!Number.isSafeInteger(file.size) || file.size < 0) fail(`Managed Community Skill manifest path "${file.path}" has an invalid size.`, 'INVALID_REQUEST')
    if (!SHA256_PATTERN.test(file.sha256)) fail(`Managed Community Skill manifest path "${file.path}" has an invalid SHA-256.`, 'INVALID_REQUEST')
    return { path: file.path, size: file.size, sha256: file.sha256 }
  })
  return normalized.sort(compareManifestPaths)
}

function validateManifestPath(path: string): void {
  if (!isSafeManifestPath(path)) {
    fail(`Managed Community Skill manifest path "${path}" is unsafe.`, 'INVALID_REQUEST')
  }
}

function isSafeManifestPath(path: string): boolean {
  return !path.endsWith('/') && isSafeManagedPath(path)
}

function validateLimits(limits: ManagedSkillAdmissionLimits): void {
  for (const [field, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) fail(`Managed skill admission limit ${field} must be a positive safe integer.`, 'INVALID_REQUEST')
  }
}

function assertManifest(actual: readonly VerifiedSkillFile[], expected: readonly ExpectedSkillFile[]): void {
  if (actual.length !== expected.length) fail('Community Skill package files do not match the Registry Instance manifest.', 'MANIFEST_MISMATCH')
  for (let index = 0; index < expected.length; index += 1) {
    const wanted = expected[index]
    const found = actual[index]
    /* v8 ignore next -- equal lengths and the loop bound guarantee both entries. */
    if (wanted === undefined || found === undefined) throw new Error('manifest comparison invariant failed')
    if (wanted.path !== found.path || wanted.size !== found.size || wanted.sha256 !== found.sha256) {
      fail(`Community Skill package file "${found.path}" does not match its Registry Instance manifest entry.`, 'MANIFEST_MISMATCH')
    }
  }
}

async function parseStagedSkill(content: string): Promise<{ name: string }> {
  let raw: string
  try {
    raw = await readFile(join(content, 'SKILL.md'), 'utf8')
  } catch (error) {
    /* v8 ignore next -- archive-root validation guarantees SKILL.md exists; only a native I/O fault reaches this branch. */
    fail('Community Skill package SKILL.md could not be read.', 'INVALID_SKILL', error)
  }
  try {
    return parseSkillDocument(raw)
  } catch (error) {
    fail('Community Skill package SKILL.md does not satisfy filesystem skill rules.', 'INVALID_SKILL', error)
  }
}

function packageKey(release: Pick<NormalizedRelease, 'identity' | 'version'>): string {
  return createHash('sha256').update([
    release.identity.registryInstanceId,
    release.identity.namespace,
    release.identity.slug,
    release.version,
  ].join('\0'), 'utf8').digest('hex')
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`Managed package storage path "${path}" is not a real directory.`, 'STORE_CORRUPT')
  await chmod(path, 0o700)
}

async function readReceiptIfPresent(packagePath: string): Promise<ManagedSkillReceipt | undefined> {
  try {
    const info = await lstat(packagePath)
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`Managed package path "${packagePath}" is not a real directory.`, 'STORE_CORRUPT')
  } catch (error) {
    if (isCode(error, 'ENOENT')) return undefined
    throw error
  }
  return await readReceipt(packagePath)
}

async function readReceipt(packagePath: string): Promise<ManagedSkillReceipt> {
  try {
    await assertDurableEntry(packagePath, 'directory')
    const receiptPath = join(packagePath, RECEIPT_FILE)
    await assertDurableEntry(receiptPath, 'file')
    const raw: unknown = JSON.parse(await readFile(receiptPath, 'utf8'))
    const receipt = validateReceipt(raw, packagePath)
    await verifyDurableContent(receipt)
    return receipt
  } catch (error) {
    if (error instanceof ManagedSkillAdmissionError) throw error
    fail(`Managed package receipt at "${packagePath}" is unreadable.`, 'STORE_CORRUPT', error)
  }
}

async function verifyDurableContent(receipt: ManagedSkillReceipt): Promise<void> {
  await assertDurableEntry(receipt.managedLocation, 'directory')
  const expected = new Map(receipt.manifest.map(file => [file.path, file]))
  const directories = managedDirectoryPaths(receipt.manifest)
  const verified = new Set<string>()
  await verifyDurableFiles(receipt.managedLocation, '', expected, directories, verified)
  if (verified.size !== expected.size) {
    fail(`Managed package content at "${receipt.managedLocation}" does not match its receipt.`, 'STORE_CORRUPT')
  }
}

function managedDirectoryPaths(manifest: readonly VerifiedSkillFile[]): ReadonlySet<string> {
  const paths = new Set<string>()
  for (const file of manifest) {
    const segments = file.path.split('/')
    segments.pop()
    for (let count = 1; count <= segments.length; count += 1) {
      paths.add(segments.slice(0, count).join('/'))
    }
  }
  return paths
}

async function verifyDurableFiles(
  root: string,
  relative: string,
  expected: ReadonlyMap<string, VerifiedSkillFile>,
  directories: ReadonlySet<string>,
  verified: Set<string>,
): Promise<void> {
  const directory = relative === '' ? root : join(root, ...relative.split('/'))
  const entries = await readdir(directory, { withFileTypes: true, encoding: 'utf8' })
  for (const entry of entries) {
    const path = relative === '' ? entry.name : posix.join(relative, entry.name)
    const absolute = join(root, ...path.split('/'))
    if (entry.isDirectory()) {
      if (!directories.has(path)) {
        fail(`Managed package content at "${root}" contains unexpected directory "${path}".`, 'STORE_CORRUPT')
      }
      await assertDurableEntry(absolute, 'directory')
      await verifyDurableFiles(root, path, expected, directories, verified)
    } else if (entry.isFile()) {
      const wanted = expected.get(path)
      if (wanted === undefined) {
        fail(`Managed package content at "${root}" contains unexpected file "${path}".`, 'STORE_CORRUPT')
      }
      const info = await assertDurableEntry(absolute, 'file')
      if (info.size !== wanted.size || await hashDurableFile(absolute) !== wanted.sha256) {
        fail(`Managed package file "${path}" does not match its receipt.`, 'STORE_CORRUPT')
      }
      verified.add(path)
    } else {
      fail(`Managed package content contains unsupported entry "${path}".`, 'STORE_CORRUPT')
    }
  }
}

async function hashDurableFile(path: string): Promise<string> {
  const handle = await open(path, 'r')
  const digest = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    for (;;) {
      const result = await handle.read(buffer, 0, buffer.byteLength)
      if (result.bytesRead === 0) break
      digest.update(buffer.subarray(0, result.bytesRead))
    }
  } finally {
    await handle.close()
  }
  return digest.digest('hex')
}

async function assertDurableEntry(path: string, kind: 'directory' | 'file'): Promise<Stats> {
  const info = await lstat(path)
  const matches = kind === 'directory' ? info.isDirectory() : info.isFile()
  if (!matches || info.isSymbolicLink()) {
    fail(`Managed package ${kind} "${path}" is not a real ${kind}.`, 'STORE_CORRUPT')
  }
  /* v8 ignore next -- Windows does not expose the POSIX mode guarantee enforced on Unix hosts. */
  if (process.platform !== 'win32') {
    const expected = kind === 'directory' ? 0o555 : 0o444
    if ((info.mode & 0o777) !== expected) {
      fail(`Managed package ${kind} "${path}" is not immutable.`, 'STORE_CORRUPT')
    }
  }
  return info
}

function validateReceipt(value: unknown, packagePath: string): ManagedSkillReceipt {
  if (!isRecord(value) || value.formatVersion !== 1 || value.enabled !== true
    || !isNonEmptyTrimmed(value.adapter) || !isCanonicalSourceServer(value.sourceServer)
    || !isNonEmptyTrimmed(value.canonicalName) || !isNonEmptyTrimmed(value.version)
    || typeof value.fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(value.fingerprint)
    || !isCanonicalIsoTime(value.installedAt)
    || value.managedLocation !== join(packagePath, CONTENT_DIRECTORY)
    || !isRecord(value.identity) || !isNonEmptyTrimmed(value.identity.registryInstanceId)
    || !isNonEmptyTrimmed(value.identity.namespace) || !isNonEmptyTrimmed(value.identity.slug)
    || !Array.isArray(value.manifest)) {
    fail(`Managed package receipt at "${packagePath}" has an unsupported format.`, 'STORE_CORRUPT')
  }
  const identity: CommunitySkillIdentity = {
    registryInstanceId: value.identity.registryInstanceId as RegistryInstanceId,
    namespace: value.identity.namespace,
    slug: value.identity.slug,
  }
  let previousPath: string | undefined
  const manifest = value.manifest.map((entry): VerifiedSkillFile => {
    if (!isRecord(entry) || typeof entry.path !== 'string' || !isSafeManifestPath(entry.path)
      || typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0
      || typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)
      || (previousPath !== undefined && previousPath >= entry.path)) {
      fail(`Managed package receipt at "${packagePath}" has an invalid manifest.`, 'STORE_CORRUPT')
    }
    previousPath = entry.path
    return { path: entry.path, size: entry.size, sha256: entry.sha256 }
  })
  if (manifest.length === 0 || computeSkillHubFingerprint(manifest) !== value.fingerprint) {
    fail(`Managed package receipt at "${packagePath}" has an invalid fingerprint.`, 'STORE_CORRUPT')
  }
  const receipt = {
    formatVersion: 1,
    identity,
    adapter: value.adapter,
    sourceServer: value.sourceServer,
    canonicalName: value.canonicalName,
    version: value.version,
    manifest,
    fingerprint: value.fingerprint,
    installedAt: value.installedAt,
    enabled: true,
    managedLocation: value.managedLocation,
  } satisfies ManagedSkillReceipt
  if (basename(packagePath) !== packageKey(receipt)) {
    fail(`Managed package receipt at "${packagePath}" does not match its storage key.`, 'STORE_CORRUPT')
  }
  return freezeReceipt(receipt)
}

function isNonEmptyTrimmed(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.trim() === value && !value.includes('\0')
}

function isCanonicalSourceServer(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.username === '' && url.password === '' && url.toString() === value
  } catch {
    return false
  }
}

function isCanonicalIsoTime(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}

function assertIdempotent(existing: ManagedSkillReceipt, release: NormalizedRelease): ManagedSkillReceipt {
  const requested = JSON.stringify({
    identity: release.identity,
    adapter: release.adapter,
    sourceServer: release.sourceServer,
    canonicalName: release.canonicalName,
    version: release.version,
    manifest: release.manifest,
    fingerprint: release.fingerprint,
  })
  const stored = JSON.stringify({
    identity: existing.identity,
    adapter: existing.adapter,
    sourceServer: existing.sourceServer,
    canonicalName: existing.canonicalName,
    version: existing.version,
    manifest: existing.manifest,
    fingerprint: existing.fingerprint,
  })
  if (requested !== stored) fail('Registry Instance changed an already admitted immutable release.', 'IMMUTABLE_RELEASE_CONFLICT')
  return existing
}

function sameRemoteIdentity(left: CommunitySkillIdentity, right: CommunitySkillIdentity): boolean {
  return left.registryInstanceId === right.registryInstanceId && left.namespace === right.namespace && left.slug === right.slug
}

async function freezeTreeContents(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true, encoding: 'utf8' })
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      await freezeTreeContents(child)
      await chmod(child, 0o555)
    }
    else if (entry.isFile()) await chmod(child, 0o444)
    /* v8 ignore start -- extraction rejects special entries and staging creates only regular files/directories. */
    else fail(`Managed package staging contains unsupported entry "${entry.name}".`, 'COMMIT_FAILED')
    /* v8 ignore stop */
  }
}

async function removeStaging(path: string): Promise<void> {
  try {
    const info = await lstat(path)
    /* v8 ignore start -- staging paths are fresh directories; only a hostile same-account replacement can create this race. */
    if (info.isSymbolicLink()) {
      await unlink(path)
      return
    }
    /* v8 ignore stop */
    /* v8 ignore next -- staging paths are directories unless a hostile same-account process replaces one. */
    if (info.isDirectory()) await thawTree(path)
    await rm(path, { recursive: true, force: true })
  } catch (error) {
    /* v8 ignore next -- non-absence cleanup failures require a platform I/O or permission fault. */
    if (!isCode(error, 'ENOENT')) throw error
  }
}

async function thawTree(path: string): Promise<void> {
  await chmod(path, 0o700)
  const entries = await readdir(path, { withFileTypes: true, encoding: 'utf8' })
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) await thawTree(child)
    else if (entry.isFile()) await chmod(child, 0o600)
    /* v8 ignore start -- admitted archives cannot create staging symlinks. */
    else if (entry.isSymbolicLink()) await unlink(child)
    /* v8 ignore stop */
  }
}

function freezeReceipt(receipt: ManagedSkillReceipt): ManagedSkillReceipt {
  Object.freeze(receipt.identity)
  for (const file of receipt.manifest) Object.freeze(file)
  Object.freeze(receipt.manifest)
  return Object.freeze(receipt)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function compareManifestPaths(left: ExpectedSkillFile, right: ExpectedSkillFile): number {
  /* v8 ignore next -- duplicate manifest paths are rejected before sorting. */
  if (left.path === right.path) return 0
  return left.path < right.path ? -1 : 1
}
