/** ZIP metadata admission and bounded extraction into a private staging tree. */

import { createHash } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { fromBufferPromise, type Entry, type ZipFile } from 'yauzl'
import { fail, ManagedSkillAdmissionError } from './error.ts'
import { isSafeManagedPath } from './path.ts'
import type { ManagedSkillAdmissionLimits, VerifiedSkillFile } from './types.ts'

interface ArchiveEntry {
  readonly entry: Entry
  readonly path: string
  readonly directory: boolean
}

/** Extracted package metadata after archive limits and path rules pass. */
export interface ExtractedSkillPackage {
  readonly files: readonly VerifiedSkillFile[]
}

/**
 * Validate and extract one ZIP below an already-private staging directory.
 * @param artifact - complete downloaded ZIP bytes.
 * @param contentRoot - empty staging directory that receives normalized package files.
 * @param limits - deployment-owned compressed, expanded, and entry limits.
 * @param signal - transfer cancellation; its reason is rethrown unchanged.
 * @returns verified path, size, and content hashes for every regular file.
 */
export async function extractSkillArchive(
  artifact: Uint8Array,
  contentRoot: string,
  limits: ManagedSkillAdmissionLimits,
  signal?: AbortSignal,
): Promise<ExtractedSkillPackage> {
  signal?.throwIfAborted()
  if (artifact.byteLength > limits.maxCompressedBytes) {
    fail('Community Skill artifact exceeds the configured compressed byte limit.', 'ARTIFACT_TOO_LARGE')
  }

  let zip: ZipFile
  try {
    zip = await fromBufferPromise(asBuffer(artifact), {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    })
  } catch (error) {
    signal?.throwIfAborted()
    fail('Community Skill artifact is not a valid ZIP archive.', 'INVALID_ARCHIVE', error)
  }

  try {
    const entries = await collectEntries(zip, limits, signal)
    const normalized = normalizePackageRoot(entries)
    const files: VerifiedSkillFile[] = []
    let writtenBytes = 0
    for (const item of normalized) {
      signal?.throwIfAborted()
      if (item.path === '') continue
      const target = join(contentRoot, ...item.path.split('/'))
      if (item.directory) continue
      const extracted = await extractFile(zip, item.entry, target, signal, (bytes) => {
        writtenBytes += bytes
        /* v8 ignore next -- yauzl validates each decoded size against the pre-checked declared total. */
        if (writtenBytes > limits.maxExpandedBytes) {
          fail('Community Skill artifact exceeds the configured expanded byte limit.', 'EXPANDED_SIZE_EXCEEDED')
        }
      })
      files.push({ path: item.path, ...extracted })
    }
    return { files: files.sort(compareArchivePaths) }
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof ManagedSkillAdmissionError) throw error
    if (isUnsafeYauzlPathError(error)) {
      fail('Community Skill archive contains an unsafe path.', 'UNSAFE_ARCHIVE_PATH', error)
    }
    fail('Community Skill artifact could not be decoded safely.', 'INVALID_ARCHIVE', error)
  } finally {
    zip.close()
  }
}

async function collectEntries(
  zip: ZipFile,
  limits: ManagedSkillAdmissionLimits,
  signal?: AbortSignal,
): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = []
  const exactPaths = new Set<string>()
  const portablePaths = new Set<string>()
  let expandedBytes = 0
  const iterator = zip.eachEntry()
  for (;;) {
    signal?.throwIfAborted()
    /* v8 ignore start -- The extraction cancellation test pins the outcome; the iterator/stream microtask winner is timing-dependent. */
    const next = await abortable(iterator.next(), signal, () => {
      zip.close()
    })
    /* v8 ignore stop */
    if (next.done) break
    if (entries.length >= limits.maxEntryCount) {
      fail('Community Skill artifact exceeds the configured archive entry limit.', 'TOO_MANY_FILES')
    }
    const entry = next.value
    const directory = classifyEntry(entry)
    const path = validateArchivePath(entry.fileName, directory)
    const portable = path.normalize('NFC').toLocaleLowerCase('en-US')
    if (exactPaths.has(path) || portablePaths.has(portable)) {
      fail(`Community Skill artifact repeats archive path "${path}".`, 'DUPLICATE_ARCHIVE_PATH')
    }
    exactPaths.add(path)
    portablePaths.add(portable)
    if (!directory) {
      /* v8 ignore next -- ZIP size fields decode from unsigned integers. */
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
        fail(`Community Skill archive entry "${path}" has an invalid expanded size.`, 'INVALID_ARCHIVE')
      }
      expandedBytes += entry.uncompressedSize
      if (!Number.isSafeInteger(expandedBytes) || expandedBytes > limits.maxExpandedBytes) {
        fail('Community Skill artifact exceeds the configured expanded byte limit.', 'EXPANDED_SIZE_EXCEEDED')
      }
    }
    entries.push({ entry, path, directory })
  }
  if (entries.length === 0) fail('Community Skill archive is empty.', 'UNSUPPORTED_PACKAGE_ROOT')
  return entries
}

function classifyEntry(entry: Entry): boolean {
  if (entry.isEncrypted() || !entry.canDecodeFileData()) {
    fail(`Community Skill archive entry "${entry.fileName}" uses unsupported encryption or compression.`, 'UNSAFE_ARCHIVE_ENTRY')
  }
  const madeBy = (entry.versionMadeBy >>> 8) & 0xff
  const unixMode = madeBy === 3 ? (entry.externalFileAttributes >>> 16) & 0xffff : undefined
  const unixType = unixMode === undefined ? 0 : unixMode & 0xf000
  const directory = entry.fileName.endsWith('/') || (entry.externalFileAttributes & 0x10) !== 0
  const volumeLabel = (entry.externalFileAttributes & 0x08) !== 0
  if (volumeLabel || (unixType !== 0 && unixType !== 0x4000 && unixType !== 0x8000)) {
    fail(`Community Skill archive entry "${entry.fileName}" is a link or special file.`, 'UNSAFE_ARCHIVE_ENTRY')
  }
  if ((directory && unixType === 0x8000) || (!directory && unixType === 0x4000)) {
    fail(`Community Skill archive entry "${entry.fileName}" has conflicting file-type metadata.`, 'UNSAFE_ARCHIVE_ENTRY')
  }
  return directory
}

function validateArchivePath(raw: string, directory: boolean): string {
  // yauzl rejects absolute, drive-qualified, parent-traversing, and backslash paths before yielding an entry.
  const path = directory && raw.endsWith('/') ? raw.slice(0, -1) : raw
  if (!isSafeManagedPath(path)) {
    fail(`Community Skill archive path "${raw}" is not a portable relative POSIX path.`, 'UNSAFE_ARCHIVE_PATH')
  }
  return path
}

function normalizePackageRoot(entries: readonly ArchiveEntry[]): ArchiveEntry[] {
  const files = entries.filter(entry => !entry.directory)
  const root = files.some(entry => entry.path === 'SKILL.md')
    ? ''
    : singleWrappedRoot(entries, files)
  if (root === '' && files.some(entry => entry.path !== 'SKILL.md' && entry.path.endsWith('/SKILL.md'))) {
    fail('Community Skill archive contains more than one SKILL.md package root.', 'UNSUPPORTED_PACKAGE_ROOT')
  }
  const normalized = entries.map(item => ({
    ...item,
    path: root === '' ? item.path : item.path === root ? '' : item.path.slice(root.length + 1),
  }))
  return normalized
}

function singleWrappedRoot(entries: readonly ArchiveEntry[], files: readonly ArchiveEntry[]): string {
  const roots = new Set(files.map(entry => entry.path.split('/')[0]))
  if (roots.size !== 1) fail('Community Skill archive must contain SKILL.md at its root or below one wrapper directory.', 'UNSUPPORTED_PACKAGE_ROOT')
  const root = roots.values().next().value
  if (root === undefined || !files.some(entry => entry.path === `${root}/SKILL.md`)) {
    fail('Community Skill archive does not contain a supported SKILL.md package root.', 'UNSUPPORTED_PACKAGE_ROOT')
  }
  if (entries.some(entry => entry.path !== root && !entry.path.startsWith(`${root}/`))) {
    fail('Community Skill archive contains entries outside its wrapper directory.', 'UNSUPPORTED_PACKAGE_ROOT')
  }
  return root
}

async function extractFile(
  zip: ZipFile,
  entry: Entry,
  target: string,
  signal: AbortSignal | undefined,
  count: (bytes: number) => void,
): Promise<{ size: number; sha256: string }> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const handle = await open(target, 'wx', 0o600)
  let stream: Readable | undefined
  let size = 0
  const digest = createHash('sha256')
  try {
    stream = await abortable(zip.openReadStreamPromise(entry), signal)
    /* v8 ignore start -- The extraction cancellation test pins the outcome; listener timing is nondeterministic. */
    const onAbort = (): void => {
      stream?.destroy(abortReason(signal))
    }
    /* v8 ignore stop */
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      for await (const value of stream) {
        signal?.throwIfAborted()
        /* v8 ignore next -- yauzl's Node Readable emits Buffer chunks. */
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
        count(chunk.byteLength)
        size += chunk.byteLength
        digest.update(chunk)
        let offset = 0
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset)
          /* v8 ignore next -- a regular-file write either advances or rejects with an I/O error. */
          if (bytesWritten === 0) throw new Error(`archive entry "${entry.fileName}" write made no progress`)
          offset += bytesWritten
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
    /* v8 ignore next -- validateEntrySizes rejects a decoded-size mismatch inside yauzl. */
    if (size !== entry.uncompressedSize) fail(`Community Skill archive entry "${entry.fileName}" changed size while decoding.`, 'INVALID_ARCHIVE')
    return { size, sha256: digest.digest('hex') }
  } catch (error) {
    /* v8 ignore next -- native stream/write faults are platform I/O failures; owned policy failures are tested above. */
    stream?.destroy()
    /* v8 ignore next -- same native I/O failure path. */
    throw error
  } finally {
    await handle.close()
  }
}

/* v8 ignore start -- End-to-end cancellation is tested; which pending yauzl promise observes abort first is timing-dependent. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal, onAbort?: () => void): Promise<T> {
  if (signal === undefined) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      onAbort?.()
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
      },
    )
  })
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('Community Skill admission aborted')
}
/* v8 ignore stop */

function isUnsafeYauzlPathError(error: unknown): boolean {
  return error instanceof Error && /^(?:absolute path|invalid characters in fileName|invalid relative path):/.test(error.message)
}

function asBuffer(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
}

function compareArchivePaths(left: VerifiedSkillFile, right: VerifiedSkillFile): number {
  /* v8 ignore next -- duplicate archive paths are rejected before extraction. */
  if (left.path === right.path) return 0
  return left.path < right.path ? -1 : 1
}
