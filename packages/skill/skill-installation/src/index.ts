/**
 * Host-only managed Community Skill package admission and immutable storage.
 *
 * The package validates downloaded ZIPs in a private staging tree and publishes
 * `content/` plus `receipt.json` through one directory rename. Its optional
 * provider exposes only enabled committed packages to `ctx.skills`.
 *
 * @module @deepseek-ai/dsh-skill-installation
 */

import { createHash, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, join, posix, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { parseSkillDocument, type ParsedSkillDocument } from '@deepseek-ai/dsh-skill-filesystem'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
  SkillProviderObservation,
} from '@deepseek-ai/dsh-skill'
import { extractSkillArchive } from './archive.ts'
import { fail, ManagedSkillAdmissionError } from './error.ts'
import { computeSkillHubFingerprint } from './fingerprint.ts'
import { isSafeManagedPath } from './path.ts'
import type {
  CommunitySkillIdentity,
  ExpectedSkillFile,
  ManagedSkillAdmissionLimits,
  ManagedInstallationServiceOptions,
  ManagedSkillEnablementResult,
  ManagedSkillInstallReceipt,
  ManagedSkillInstallRequest,
  ManagedSkillInstallResult,
  ManagedSkillLifecycleRequest,
  ManagedSkillLifecycleResult,
  ManagedSkillReceipt,
  ManagedSkillRelease,
  ManagedSkillReleaseResolver,
  ManagedSkillUninstallResult,
  ManagedSkillUpdateRequest,
  ManagedSkillUpdateResult,
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
  ManagedInstallationServiceOptions,
  ManagedSkillEnablementResult,
  ManagedSkillInstallReceipt,
  ManagedSkillInstallRequest,
  ManagedSkillInstallResult,
  ManagedSkillLifecycleRequest,
  ManagedSkillLifecycleResult,
  ManagedSkillReceipt,
  ManagedSkillRelease,
  ManagedSkillReleaseResolver,
  ManagedSkillUninstallResult,
  ManagedSkillUpdateRequest,
  ManagedSkillUpdateResult,
  ManagedSkillStoreOptions,
  RegistryInstanceId,
  VerifiedSkillFile,
} from './types.ts'

/** Stable provider name used for managed Community Skill candidates. */
export const MANAGED_SKILL_PROVIDER_NAME = 'managed'
const MANAGED_SKILL_RANK = 550

const RECEIPT_FILE = 'receipt.json'
const CONTENT_DIRECTORY = 'content'
const OPERATION_DIRECTORY = 'operations'
const TARGET_OPERATION_DIRECTORY = 'targets'
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

interface InstallTarget {
  readonly identity: CommunitySkillIdentity
  readonly version: string
}

interface UpdateTarget {
  readonly identity: CommunitySkillIdentity
  readonly fromVersion: string
  readonly toVersion: string
}

interface RunningInstallOperation {
  readonly formatVersion: 1
  readonly operation: ManagedSkillLifecycleResult['operation']
  readonly status: 'running'
  readonly targetKey: string
  readonly ownerPid: number
  readonly startedAt: string
}

interface CompletedInstallOperation {
  readonly formatVersion: 1
  readonly operation: ManagedSkillLifecycleResult['operation']
  readonly status: 'completed'
  readonly targetKey: string
  readonly completedAt: string
  readonly result: ManagedSkillLifecycleResult
}

type InstallOperationRecord = RunningInstallOperation | CompletedInstallOperation

interface TargetInstallLock {
  readonly formatVersion: 1
  readonly targetKey: string
  readonly ownerPid: number
  readonly startedAt: string
}

interface ActiveInstallOperation {
  readonly targetKey: string
  readonly operation: ManagedSkillLifecycleResult['operation']
  readonly result: Promise<ManagedSkillLifecycleResult>
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

  /**
   * Reconcile storage after process restart and return verified packages.
   * @returns complete durable receipts still owned by this managed store.
   */
  async recover(): Promise<readonly ManagedSkillReceipt[]> {
    await this.prepareStorage()
    await cleanupDirectory(this.stagingRoot)
    const receipts: ManagedSkillReceipt[] = []
    const entries = await readdir(this.packagesRoot, { withFileTypes: true, encoding: 'utf8' })
    for (const entry of entries) {
      const path = join(this.packagesRoot, entry.name)
      if (entry.name.startsWith('.admitting-')) {
        await removeStaging(path)
        continue
      }
      if (!entry.isDirectory()) fail(`Managed package store contains unsupported entry "${entry.name}".`, 'STORE_CORRUPT')
      receipts.push(await readReceipt(path))
    }
    return receipts
  }

  /**
   * Read all complete managed package receipts without cleanup.
   * @returns verified durable receipts.
   */
  async listReceipts(): Promise<readonly ManagedSkillReceipt[]> {
    await this.prepareStorage()
    const receipts: ManagedSkillReceipt[] = []
    const entries = await readdir(this.packagesRoot, { withFileTypes: true, encoding: 'utf8' })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.admitting-')) {
        fail(`Managed package store contains unsupported entry "${entry.name}".`, 'STORE_CORRUPT')
      }
      receipts.push(await readReceipt(join(this.packagesRoot, entry.name)))
    }
    return receipts
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

/** Host-owned lifecycle service for exact managed installs. */
export class ManagedInstallationService {
  private readonly store: ManagedSkillStore
  private readonly resolver: ManagedSkillReleaseResolver
  private readonly operationRoot: string
  private readonly targetOperationRoot: string
  private readonly now: () => Date
  private readonly activeTargets = new Set<string>()
  private readonly activeOperations = new Map<string, ActiveInstallOperation>()
  private readonly changeListeners = new Set<() => void>()
  private ready: Promise<void> | undefined

  /**
   * Create a lifecycle service over one managed installation root.
   * @param options - storage, admission limits, resolver, and optional clock.
   */
  constructor(options: ManagedInstallationServiceOptions) {
    this.store = new ManagedSkillStore(options)
    this.resolver = options.resolver
    this.operationRoot = join(this.store.root, OPERATION_DIRECTORY)
    this.targetOperationRoot = join(this.operationRoot, TARGET_OPERATION_DIRECTORY)
    this.now = options.now ?? (() => new Date())
  }

  /**
   * Subscribe to durable installation changes so a managed provider can invalidate its catalog.
   * @param listener - callback invoked after a lifecycle result is durable.
   * @returns a disposer that removes the listener.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }

  /**
   * Read verified receipts for provider discovery.
   * @returns the currently valid managed installation receipts.
   */
  async listReceipts(): Promise<readonly ManagedSkillReceipt[]> {
    await this.ensureReady()
    return await this.store.listReceipts()
  }

  /**
   * Reconcile package and operation state after process restart.
   * @returns complete installed package receipts after recovery.
   */
  async recover(): Promise<readonly ManagedSkillReceipt[]> {
    const receipts = await this.store.recover()
    await ensurePrivateDirectory(this.operationRoot)
    await ensurePrivateDirectory(this.targetOperationRoot)
    await cleanupStaleTargetLocks(this.targetOperationRoot)
    const entries = await readdir(this.operationRoot, { withFileTypes: true, encoding: 'utf8' })
    for (const entry of entries) {
      if (entry.name === TARGET_OPERATION_DIRECTORY && entry.isDirectory()) continue
      const path = join(this.operationRoot, entry.name)
      if (!entry.isFile()) fail(`Managed installation operation store contains unsupported entry "${entry.name}".`, 'OPERATION_RECORD_CORRUPT')
      const record = await readInstallOperation(path)
      if (record.status === 'running') {
        if (!isProcessAlive(record.ownerPid)) await rm(path, { force: true })
        continue
      }
      if (record.operation !== 'uninstall') await receiptForCompletedOperation(this.store.root, record)
    }
    return receipts
  }

  /**
   * Install one exact Community Skill release with an idempotency key.
   * @param request - exact identity, version, and caller-minted idempotency key.
   * @param signal - optional cancellation before the durable commit point.
   * @returns durable install result.
   */
  async install(request: ManagedSkillInstallRequest, signal?: AbortSignal): Promise<ManagedSkillInstallResult> {
    const target = normalizeInstallRequest(request)
    const operationKey = operationKeyFor(request.idempotencyKey)
    const targetKey = packageKey(target)
    const active = this.activeOperations.get(operationKey)
    if (active !== undefined) {
      assertSameOperation(active.operation, 'install')
      assertSameOperationTarget(active.targetKey, targetKey)
      return await active.result as ManagedSkillInstallResult
    }
    const operation = this.performInstall(target, targetKey, request.idempotencyKey, signal)
    this.activeOperations.set(operationKey, { operation: 'install', targetKey, result: operation })
    try {
      return await operation
    } finally {
      this.activeOperations.delete(operationKey)
    }
  }

  private async performInstall(
    target: InstallTarget,
    targetKey: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ManagedSkillInstallResult> {
    await this.ensureReady()
    signal?.throwIfAborted()
    const operationPath = this.operationPath(idempotencyKey)
    const existing = await readInstallOperationIfPresent(operationPath)
    if (existing !== undefined) assertSameOperation(existing.operation, 'install')
    if (existing !== undefined) assertSameOperationTarget(existing.targetKey, targetKey)
    if (existing?.status === 'completed') return existing.result as ManagedSkillInstallResult
    if (existing?.status === 'running') fail('Managed installation operation is already in progress.', 'OPERATION_IN_PROGRESS')
    if (this.activeTargets.has(targetKey)) fail('Managed installation operation is already in progress.', 'OPERATION_IN_PROGRESS')
    this.activeTargets.add(targetKey)
    let committed: ManagedSkillReceipt | undefined
    let targetLock: (() => Promise<void>) | undefined
    try {
      targetLock = await acquireTargetInstallLock(this.targetOperationRoot, targetKey, this.now)
      await writeInstallOperation(operationPath, {
        formatVersion: 1,
        operation: 'install',
        status: 'running',
        targetKey,
        ownerPid: process.pid,
        startedAt: this.now().toISOString(),
      })
      const release = await resolveInstallRelease(this.resolver, target, signal)
      assertResolvedReleaseMatches(target, release)
      committed = await this.store.admit(release, signal)
      const result: ManagedSkillInstallResult = { operation: 'install', receipt: projectInstallReceipt(committed) }
      await writeInstallOperation(operationPath, {
        formatVersion: 1,
        operation: 'install',
        status: 'completed',
        targetKey,
        completedAt: this.now().toISOString(),
        result,
      })
      this.notifyChange()
      return result
    } catch (error) {
      if (committed !== undefined) {
        fail('Managed installation completed, but its idempotency record could not be persisted.', 'OPERATION_RECORD_CORRUPT')
      }
      await rm(operationPath, { force: true }).catch(() => {})
      signal?.throwIfAborted()
      if (error instanceof ManagedSkillAdmissionError) throw error
      fail('Managed installation operation failed before durable commit.', 'COMMIT_FAILED', error)
    } finally {
      if (targetLock !== undefined) await targetLock().catch(() => {})
      this.activeTargets.delete(targetKey)
    }
    /* v8 ignore next -- the try/catch above always returns or throws. */
    throw new Error('managed installation invariant failed')
  }

  /**
   * Enable one exact installed managed package.
   * @param request - exact identity, version, and caller-minted idempotency key.
   * @returns enablement result with a safe receipt projection.
   */
  async enable(request: ManagedSkillLifecycleRequest): Promise<ManagedSkillEnablementResult> {
    return await this.performReceiptMutation('enable', normalizeLifecycleRequest(request), request.idempotencyKey, true)
  }

  /**
   * Disable one exact installed managed package without deleting content.
   * @param request - exact identity, version, and caller-minted idempotency key.
   * @returns enablement result with a safe receipt projection.
   */
  async disable(request: ManagedSkillLifecycleRequest): Promise<ManagedSkillEnablementResult> {
    return await this.performReceiptMutation('disable', normalizeLifecycleRequest(request), request.idempotencyKey, false)
  }

  /**
   * Remove one exact managed package and stale operation records for that target.
   * @param request - exact identity, version, and caller-minted idempotency key.
   * @returns uninstall result indicating whether a package was present.
   */
  async uninstall(request: ManagedSkillLifecycleRequest): Promise<ManagedSkillUninstallResult> {
    const target = normalizeLifecycleRequest(request)
    const targetKey = packageKey(target)
    return await this.performLifecycleOperation('uninstall', targetKey, request.idempotencyKey, async () => {
      const receipt = await readReceiptIfPresent(this.packagePath(targetKey))
      if (receipt !== undefined) await removeManagedPackage(this.packagePath(targetKey))
      await removeOperationRecordsForTarget(this.operationRoot, targetKey, operationKeyFor(request.idempotencyKey))
      return {
        operation: 'uninstall',
        identity: target.identity,
        version: target.version,
        removed: receipt !== undefined,
      }
    }) as ManagedSkillUninstallResult
  }

  /**
   * Admit and enable one target version while disabling the installed previous version.
   * @param request - exact identity, previous version, target version, and caller-minted idempotency key.
   * @param signal - optional cancellation before the durable commit point.
   * @returns update result with the target receipt and disabled previous receipt.
   */
  async update(request: ManagedSkillUpdateRequest, signal?: AbortSignal): Promise<ManagedSkillUpdateResult> {
    const target = normalizeUpdateRequest(request)
    const targetKey = packageKey({ identity: target.identity, version: target.toVersion })
    return await this.performLifecycleOperation('update', targetKey, request.idempotencyKey, async () => {
      const fromPath = this.packagePath(packageKey({ identity: target.identity, version: target.fromVersion }))
      const previous = await readReceiptIfPresent(fromPath)
      if (previous === undefined) fail('Managed update source version is not installed.', 'INVALID_REQUEST')
      const release = await resolveInstallRelease(this.resolver, { identity: target.identity, version: target.toVersion }, signal)
      assertResolvedReleaseMatches({ identity: target.identity, version: target.toVersion }, release)
      await this.store.admit(release, signal)
      const targetPath = this.packagePath(targetKey)
      await writeReceiptState(targetPath, false)
      try {
        await writeReceiptState(fromPath, false)
        const enabled = await writeReceiptState(targetPath, true)
        return {
          operation: 'update',
          receipt: projectInstallReceipt(enabled),
          previousReceipt: projectInstallReceipt({ ...previous, enabled: false }),
        }
      } catch (error) {
        await writeReceiptState(fromPath, previous.enabled).catch(() => {})
        await writeReceiptState(targetPath, false).catch(() => {})
        throw error
      }
    }) as ManagedSkillUpdateResult
  }

  private async performReceiptMutation(
    operation: 'enable' | 'disable',
    target: InstallTarget,
    idempotencyKey: string,
    enabled: boolean,
  ): Promise<ManagedSkillEnablementResult> {
    const targetKey = packageKey(target)
    return await this.performLifecycleOperation(operation, targetKey, idempotencyKey, async () => {
      const receipt = await writeReceiptState(this.packagePath(targetKey), enabled)
      return { operation, receipt: projectInstallReceipt(receipt) }
    }) as ManagedSkillEnablementResult
  }

  private async performLifecycleOperation(
    operation: ManagedSkillLifecycleResult['operation'],
    targetKey: string,
    idempotencyKey: string,
    mutate: () => Promise<ManagedSkillLifecycleResult>,
  ): Promise<ManagedSkillLifecycleResult> {
    await this.ensureReady()
    const operationKey = operationKeyFor(idempotencyKey)
    const active = this.activeOperations.get(operationKey)
    if (active !== undefined) {
      assertSameOperation(active.operation, operation)
      assertSameOperationTarget(active.targetKey, targetKey)
      return await active.result
    }
    const running = this.performLifecycleOperationLocked(operation, targetKey, idempotencyKey, mutate)
    this.activeOperations.set(operationKey, { operation, targetKey, result: running })
    try {
      return await running
    } finally {
      this.activeOperations.delete(operationKey)
    }
  }

  private async performLifecycleOperationLocked(
    operation: ManagedSkillLifecycleResult['operation'],
    targetKey: string,
    idempotencyKey: string,
    mutate: () => Promise<ManagedSkillLifecycleResult>,
  ): Promise<ManagedSkillLifecycleResult> {
    const operationPath = this.operationPath(idempotencyKey)
    const existing = await readInstallOperationIfPresent(operationPath)
    if (existing !== undefined) assertSameOperation(existing.operation, operation)
    if (existing !== undefined) assertSameOperationTarget(existing.targetKey, targetKey)
    if (existing?.status === 'completed') return existing.result
    if (existing?.status === 'running') fail('Managed installation operation is already in progress.', 'OPERATION_IN_PROGRESS')
    let targetLock: (() => Promise<void>) | undefined
    try {
      targetLock = await acquireTargetInstallLock(this.targetOperationRoot, targetKey, this.now)
      await writeInstallOperation(operationPath, {
        formatVersion: 1,
        operation,
        status: 'running',
        targetKey,
        ownerPid: process.pid,
        startedAt: this.now().toISOString(),
      })
      const result = await mutate()
      await writeInstallOperation(operationPath, {
        formatVersion: 1,
        operation,
        status: 'completed',
        targetKey,
        completedAt: this.now().toISOString(),
        result,
      })
      this.notifyChange()
      return result
    } catch (error) {
      await rm(operationPath, { force: true }).catch(() => {})
      if (error instanceof ManagedSkillAdmissionError) throw error
      fail('Managed lifecycle operation failed before durable completion.', 'COMMIT_FAILED', error)
    } finally {
      if (targetLock !== undefined) await targetLock().catch(() => {})
    }
    /* v8 ignore next -- the try/catch above always returns or throws. */
    throw new Error('managed lifecycle invariant failed')
  }

  private operationPath(idempotencyKey: string): string {
    return join(this.operationRoot, `${operationKeyFor(idempotencyKey)}.json`)
  }

  private packagePath(targetKey: string): string {
    return join(this.store.root, 'packages', targetKey)
  }

  private async ensureReady(): Promise<void> {
    const current = this.ready
    if (current !== undefined) {
      await current
      return
    }
    const recovery = this.recover().then(
      () => {},
      (error: unknown) => {
        if (this.ready === recovery) this.ready = undefined
        throw error
      },
    )
    this.ready = recovery
    await recovery
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) {
      try { listener() } catch { /* invalidation is advisory after durable commit */ }
    }
  }
}

interface ManagedSkillLocator {
  readonly receipt: ManagedSkillReceipt
  readonly document: ParsedSkillDocument
}

/** Provider exposing enabled, verified managed packages through `ctx.skills`. */
export class ManagedSkillProvider implements SkillProvider {
  readonly name = MANAGED_SKILL_PROVIDER_NAME

  constructor(
    private readonly service: ManagedInstallationService,
    control?: SkillProviderControl,
    private readonly reportFailure: (error: unknown) => void = () => {},
  ) {
    if (control !== undefined) {
      const unsubscribe = service.onChange(control.invalidate)
      control.signal.addEventListener('abort', unsubscribe, { once: true })
    }
  }

  /**
   * Discover enabled managed packages after startup reconciliation.
   * @param options - lookup options whose signal cancels receipt and document reads.
   * @returns candidates, or an incomplete observation when durable discovery fails after startup.
   * @throws when cancellation is requested; other provider-owned read failures are represented by `complete: false`.
   */
  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[] | SkillProviderObservation> {
    let receipts: readonly ManagedSkillReceipt[]
    try {
      receipts = await this.service.listReceipts()
    } catch (error) {
      options.signal?.throwIfAborted()
      this.reportFailure(error)
      return { candidates: [], complete: false }
    }
    const candidates: SkillCandidate[] = []
    let complete = true
    for (const receipt of receipts) {
      options.signal?.throwIfAborted()
      if (!receipt.enabled) continue
      try {
        const document = await readManagedSkillDocument(receipt, options.signal)
        if (document === undefined) {
          throw new Error(`managed skill "${receipt.canonicalName}" is missing its committed SKILL.md`)
        }
        if (document.name !== receipt.canonicalName) {
          throw new Error(`managed skill "${receipt.canonicalName}" does not match its committed SKILL.md name`)
        }
        candidates.push({
          name: document.name,
          description: document.description,
          ...document.whenToUse !== undefined ? { whenToUse: document.whenToUse } : {},
          invocation: document.invocation,
          source: 'custom',
          provider: this.name,
          rank: MANAGED_SKILL_RANK,
          locator: { receipt, document },
          resourceBase: managedResourceBase(),
          ...document.metadata !== undefined ? { metadata: document.metadata } : {},
        })
      } catch (error) {
        options.signal?.throwIfAborted()
        this.reportFailure(error)
        complete = false
      }
    }
    return complete ? candidates : { candidates, complete }
  }

  /**
   * Load a listed managed package only while its verified receipt remains enabled.
   * @param candidate - candidate previously returned by {@link list}.
   * @param options - lookup options whose signal cancels the load.
   * @returns the parsed definition, or `undefined` when the receipt was disabled or removed.
   */
  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const locator = candidate.locator as ManagedSkillLocator
    options.signal?.throwIfAborted()
    const current = (await this.service.listReceipts()).find(receipt =>
      receipt.enabled
      && receipt.version === locator.receipt.version
      && sameRemoteIdentity(receipt.identity, locator.receipt.identity),
    )
    if (current === undefined) return undefined
    const parsed = locator.document
    if (parsed.name !== candidate.name) return undefined
    return {
      name: parsed.name,
      description: parsed.description,
      ...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
      invocation: parsed.invocation,
      source: 'custom',
      provider: this.name,
      resourceBase: managedResourceBase(),
      ...parsed.metadata !== undefined ? { metadata: parsed.metadata } : {},
      content: parsed.content,
    }
  }
}

function managedResourceBase(): { readonly kind: 'opaque'; readonly description: string } {
  return { kind: 'opaque', description: 'Resources are managed by the local Skill Center.' }
}

async function readManagedSkillDocument(
  receipt: ManagedSkillReceipt,
  signal?: AbortSignal,
): Promise<ParsedSkillDocument | undefined> {
  try {
    const raw = await readFile(join(receipt.managedLocation, 'SKILL.md'), { encoding: 'utf8', signal })
    return parseSkillDocument(raw)
  } catch (error) {
    signal?.throwIfAborted()
    if (isCode(error, 'ENOENT') || isCode(error, 'ENOTDIR')) return undefined
    throw error
  }
}

/** Register a managed installation provider on an existing skill registry. */
export const apply = (ctx: Context, service: ManagedInstallationService): (() => void) => {
  return ctx.skills.registerProvider(control => new ManagedSkillProvider(
    service,
    control,
    (error) => { ctx.logger.warn(`managed skill provider discovery incomplete: ${String(error)}`) },
  ))
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

function normalizeInstallRequest(request: ManagedSkillInstallRequest): InstallTarget {
  for (const [field, value] of [
    ['registryInstanceId', request.identity.registryInstanceId],
    ['namespace', request.identity.namespace],
    ['slug', request.identity.slug],
    ['version', request.version],
    ['idempotencyKey', request.idempotencyKey],
  ] as const) {
    if (value === '' || value.trim() !== value || value.includes('\0')) {
      fail(`Managed installation ${field} must be a non-empty trimmed string.`, 'INVALID_REQUEST')
    }
  }
  return {
    identity: { ...request.identity },
    version: request.version,
  }
}

function normalizeLifecycleRequest(request: ManagedSkillLifecycleRequest): InstallTarget {
  for (const [field, value] of [
    ['registryInstanceId', request.identity.registryInstanceId],
    ['namespace', request.identity.namespace],
    ['slug', request.identity.slug],
    ['version', request.version],
    ['idempotencyKey', request.idempotencyKey],
  ] as const) {
    if (value === '' || value.trim() !== value || value.includes('\0')) {
      fail(`Managed lifecycle ${field} must be a non-empty trimmed string.`, 'INVALID_REQUEST')
    }
  }
  return { identity: { ...request.identity }, version: request.version }
}

function normalizeUpdateRequest(request: ManagedSkillUpdateRequest): UpdateTarget {
  for (const [field, value] of [
    ['registryInstanceId', request.identity.registryInstanceId],
    ['namespace', request.identity.namespace],
    ['slug', request.identity.slug],
    ['fromVersion', request.fromVersion],
    ['toVersion', request.toVersion],
    ['idempotencyKey', request.idempotencyKey],
  ] as const) {
    if (value === '' || value.trim() !== value || value.includes('\0')) {
      fail(`Managed update ${field} must be a non-empty trimmed string.`, 'INVALID_REQUEST')
    }
  }
  if (request.fromVersion === request.toVersion) fail('Managed update requires different source and target versions.', 'INVALID_REQUEST')
  return { identity: { ...request.identity }, fromVersion: request.fromVersion, toVersion: request.toVersion }
}

function assertResolvedReleaseMatches(target: InstallTarget, release: ManagedSkillRelease): void {
  if (release.identity.registryInstanceId !== target.identity.registryInstanceId
    || release.identity.namespace !== target.identity.namespace
    || release.identity.slug !== target.identity.slug
    || release.version !== target.version) {
    fail('Registry Instance resolved a different Community Skill release than requested.', 'IMMUTABLE_RELEASE_CONFLICT')
  }
}

async function resolveInstallRelease(
  resolver: ManagedSkillReleaseResolver,
  target: InstallTarget,
  signal?: AbortSignal,
): Promise<ManagedSkillRelease> {
  try {
    return await resolver.resolve(target, signal)
  } catch (error) {
    signal?.throwIfAborted()
    fail('Managed installation release is unavailable.', 'RELEASE_UNAVAILABLE', error)
  }
}

function assertSameOperationTarget(recordedTargetKey: string, targetKey: string): void {
  if (recordedTargetKey !== targetKey) {
    fail('Managed installation idempotency key is already bound to another lifecycle target.', 'IDEMPOTENCY_KEY_CONFLICT')
  }
}

function assertSameOperation(recorded: ManagedSkillLifecycleResult['operation'], requested: ManagedSkillLifecycleResult['operation']): void {
  if (recorded !== requested) {
    fail('Managed installation idempotency key is already bound to another operation.', 'IDEMPOTENCY_KEY_CONFLICT')
  }
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

function operationKeyFor(idempotencyKey: string): string {
  if (idempotencyKey === '' || idempotencyKey.trim() !== idempotencyKey || idempotencyKey.includes('\0')) {
    fail('Managed installation idempotency key must be a non-empty trimmed string.', 'INVALID_REQUEST')
  }
  return createHash('sha256').update(idempotencyKey, 'utf8').digest('hex')
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`Managed package storage path "${path}" is not a real directory.`, 'STORE_CORRUPT')
  await chmod(path, 0o700)
}

async function cleanupDirectory(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true, encoding: 'utf8' })
  for (const entry of entries) await removeStaging(join(path, entry.name))
}

async function writeInstallOperation(path: string, record: InstallOperationRecord): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}

async function removeOperationRecordsForTarget(root: string, targetKey: string, exceptOperationKey: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true, encoding: 'utf8' })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    if (entry.name === `${exceptOperationKey}.json`) continue
    const path = join(root, entry.name)
    const record = await readInstallOperation(path)
    if (record.targetKey === targetKey) await rm(path, { force: true })
  }
}

async function acquireTargetInstallLock(
  root: string,
  targetKey: string,
  now: () => Date,
): Promise<() => Promise<void>> {
  await ensurePrivateDirectory(root)
  const path = join(root, `${targetKey}.json`)
  for (;;) {
    try {
      const record: TargetInstallLock = {
        formatVersion: 1,
        targetKey,
        ownerPid: process.pid,
        startedAt: now().toISOString(),
      }
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      return async () => { await rm(path, { force: true }) }
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error
    }
    const stale = await isStaleTargetLock(path, targetKey)
    if (!stale) fail('Managed installation operation is already in progress.', 'OPERATION_IN_PROGRESS')
    await rm(path, { force: true })
  }
}

async function cleanupStaleTargetLocks(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true, encoding: 'utf8' })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (!entry.isFile()) fail(`Managed installation target operation store contains unsupported entry "${entry.name}".`, 'OPERATION_RECORD_CORRUPT')
    if (await isStaleTargetLock(path)) await rm(path, { force: true })
  }
}

async function isStaleTargetLock(path: string, expectedTargetKey?: string): Promise<boolean> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!isRecord(raw) || raw.formatVersion !== 1 || typeof raw.targetKey !== 'string' || !SHA256_PATTERN.test(raw.targetKey)
    || typeof raw.ownerPid !== 'number' || !Number.isSafeInteger(raw.ownerPid) || raw.ownerPid < 1
    || !isCanonicalIsoTime(raw.startedAt)) {
    return true
  }
  if (expectedTargetKey !== undefined && raw.targetKey !== expectedTargetKey) return true
  return !isProcessAlive(raw.ownerPid)
}

async function readInstallOperationIfPresent(path: string): Promise<InstallOperationRecord | undefined> {
  try {
    return await readInstallOperation(path)
  } catch (error) {
    if (isCode(error, 'ENOENT')) return undefined
    throw error
  }
}

async function readInstallOperation(path: string): Promise<InstallOperationRecord> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) {
      fail('Managed installation operation record is not a real file.', 'OPERATION_RECORD_CORRUPT')
    }
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
    return validateInstallOperation(raw)
  } catch (error) {
    if (isCode(error, 'ENOENT')) throw error
    if (error instanceof ManagedSkillAdmissionError) throw error
    fail('Managed installation operation record is unreadable.', 'OPERATION_RECORD_CORRUPT', error)
  }
}

function validateInstallOperation(value: unknown): InstallOperationRecord {
  if (!isRecord(value) || value.formatVersion !== 1 || !isLifecycleOperation(value.operation)
    || typeof value.status !== 'string' || typeof value.targetKey !== 'string' || !SHA256_PATTERN.test(value.targetKey)) {
    fail('Managed installation operation record has an unsupported format.', 'OPERATION_RECORD_CORRUPT')
  }
  if (value.status === 'running') {
    if (typeof value.ownerPid !== 'number' || !Number.isSafeInteger(value.ownerPid) || value.ownerPid < 1
      || !isCanonicalIsoTime(value.startedAt)) {
      fail('Managed installation operation record has an invalid start time.', 'OPERATION_RECORD_CORRUPT')
    }
    return {
      formatVersion: 1,
      operation: value.operation,
      status: 'running',
      targetKey: value.targetKey,
      ownerPid: value.ownerPid,
      startedAt: value.startedAt,
    }
  }
  if (value.status === 'completed') {
    if (!isCanonicalIsoTime(value.completedAt) || !isLifecycleResult(value.result, value.operation)) {
      fail('Managed installation operation record has an invalid completion time.', 'OPERATION_RECORD_CORRUPT')
    }
    return {
      formatVersion: 1,
      operation: value.operation,
      status: 'completed',
      targetKey: value.targetKey,
      completedAt: value.completedAt,
      result: value.result,
    }
  }
  fail('Managed installation operation record has an unsupported status.', 'OPERATION_RECORD_CORRUPT')
}

async function receiptForCompletedOperation(root: string, record: CompletedInstallOperation): Promise<ManagedSkillReceipt> {
  return await readReceipt(join(root, 'packages', record.targetKey))
}

function isLifecycleOperation(value: unknown): value is ManagedSkillLifecycleResult['operation'] {
  return value === 'install' || value === 'update' || value === 'enable' || value === 'disable' || value === 'uninstall'
}

function isLifecycleResult(value: unknown, operation: ManagedSkillLifecycleResult['operation']): value is ManagedSkillLifecycleResult {
  if (!isRecord(value) || value.operation !== operation) return false
  if (operation === 'uninstall') {
    return isRecord(value.identity) && isNonEmptyTrimmed(value.identity.registryInstanceId)
      && isNonEmptyTrimmed(value.identity.namespace) && isNonEmptyTrimmed(value.identity.slug)
      && isNonEmptyTrimmed(value.version) && typeof value.removed === 'boolean'
  }
  if (operation === 'update') {
    return isInstallReceiptProjection(value.receipt)
      && isInstallReceiptProjection(value.previousReceipt)
  }
  return isInstallReceiptProjection(value.receipt)
}

function isInstallReceiptProjection(value: unknown): value is ManagedSkillInstallReceipt {
  return isRecord(value) && value.formatVersion === 1 && typeof value.enabled === 'boolean'
    && isNonEmptyTrimmed(value.adapter) && isNonEmptyTrimmed(value.canonicalName) && isNonEmptyTrimmed(value.version)
    && typeof value.fingerprint === 'string' && FINGERPRINT_PATTERN.test(value.fingerprint)
    && isCanonicalIsoTime(value.installedAt)
    && isRecord(value.identity) && isNonEmptyTrimmed(value.identity.registryInstanceId)
    && isNonEmptyTrimmed(value.identity.namespace) && isNonEmptyTrimmed(value.identity.slug)
    && Array.isArray(value.manifest)
}

function projectInstallReceipt(receipt: ManagedSkillReceipt): ManagedSkillInstallReceipt {
  return {
    formatVersion: receipt.formatVersion,
    identity: receipt.identity,
    adapter: receipt.adapter,
    canonicalName: receipt.canonicalName,
    version: receipt.version,
    manifest: receipt.manifest,
    fingerprint: receipt.fingerprint,
    installedAt: receipt.installedAt,
    enabled: receipt.enabled,
  }
}

async function writeReceiptState(packagePath: string, enabled: boolean): Promise<ManagedSkillReceipt> {
  const current = await readReceipt(packagePath)
  if (current.enabled === enabled) return current
  const receipt: ManagedSkillReceipt = { ...current, enabled }
  const receiptPath = join(packagePath, RECEIPT_FILE)
  try {
    await chmod(packagePath, 0o700)
    // Windows refuses to replace a read-only target during rename. The receipt
    // is store-owned and already validated above, so make that exact file
    // writable before the atomic replacement, then restore its immutable mode.
    await chmod(receiptPath, 0o600)
    await writeFileAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o444, dirMode: 0o700 })
    await chmod(receiptPath, 0o444)
  } finally {
    await chmod(packagePath, 0o555).catch(() => {})
  }
  return await readReceipt(packagePath)
}

async function removeManagedPackage(packagePath: string): Promise<void> {
  await removeStaging(packagePath)
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
  if (!isRecord(value) || value.formatVersion !== 1 || typeof value.enabled !== 'boolean'
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
    enabled: value.enabled,
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (isCode(error, 'ESRCH')) return false
    return true
  }
}

function compareManifestPaths(left: ExpectedSkillFile, right: ExpectedSkillFile): number {
  /* v8 ignore next -- duplicate manifest paths are rejected before sorting. */
  if (left.path === right.path) return 0
  return left.path < right.path ? -1 : 1
}
