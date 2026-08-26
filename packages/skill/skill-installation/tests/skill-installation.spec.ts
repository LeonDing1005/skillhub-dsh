import { createHash } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Zip, ZipPassThrough } from 'fflate'
import {
  computeSkillHubFingerprint,
  ManagedSkillStore,
  registryInstanceId,
  type ExpectedSkillFile,
  type ManagedSkillAdmissionErrorCode,
  type ManagedSkillRelease,
} from '../src/index.ts'

interface ZipEntryInput {
  readonly path: string
  readonly content?: string | Uint8Array
  readonly mode?: number
  readonly os?: number
  readonly attributes?: number
}

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await makeWritable(root)
    await rm(root, { recursive: true, force: true })
  }
})

async function tempRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dsh-${name}-`))
  roots.push(root)
  return root
}

function bytes(value: string | Uint8Array = ''): Uint8Array {
  return typeof value === 'string' ? Buffer.from(value) : value
}

async function zipEntries(entries: readonly ZipEntryInput[]): Promise<Uint8Array> {
  return await new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = []
    const zip = new Zip((error, chunk, final) => {
      if (error !== null) {
        reject(error)
        return
      }
      chunks.push(chunk)
      if (final) resolve(Buffer.concat(chunks.map(value => Buffer.from(value))))
    })
    for (const entry of entries) {
      const file = new ZipPassThrough(entry.path)
      file.os = entry.os ?? 3
      file.attrs = entry.attributes ?? (((entry.mode ?? 0o100644) << 16) >>> 0)
      zip.add(file)
      file.push(bytes(entry.content), true)
    }
    zip.end()
  })
}

function patchFirstZipEntry(
  artifact: Uint8Array,
  patch: (bytes: Buffer, localHeader: number, centralHeader: number) => void,
): Uint8Array {
  const value = Buffer.from(artifact)
  const localHeader = value.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  const centralHeader = value.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  if (localHeader < 0 || centralHeader < 0) throw new Error('ZIP fixture lacks headers')
  patch(value, localHeader, centralHeader)
  return value
}

function skillDocument(name = 'weather'): string {
  return `---\nname: ${name}\ndescription: Weather skill\n---\n\nUse weather.\n`
}

function manifest(files: Readonly<Record<string, string | Uint8Array>>): ExpectedSkillFile[] {
  return Object.entries(files).map(([path, content]) => {
    const data = bytes(content)
    return {
      path,
      size: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
    }
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

async function release(
  entries: readonly ZipEntryInput[],
  options: Partial<Omit<ManagedSkillRelease, 'identity' | 'artifact' | 'manifest' | 'fingerprint'>> & {
    readonly identity?: Partial<ManagedSkillRelease['identity']>
    readonly expectedFiles?: Readonly<Record<string, string | Uint8Array>>
    readonly expectedManifest?: readonly ExpectedSkillFile[]
    readonly fingerprint?: string
  } = {},
): Promise<ManagedSkillRelease> {
  const expected = options.expectedManifest ?? manifest(options.expectedFiles ?? { 'SKILL.md': skillDocument() })
  return {
    identity: {
      registryInstanceId: options.identity?.registryInstanceId ?? registryInstanceId('primary'),
      namespace: options.identity?.namespace ?? 'global',
      slug: options.identity?.slug ?? 'weather',
    },
    adapter: options.adapter ?? 'skillhub',
    sourceServer: options.sourceServer ?? 'https://skills.example.test',
    canonicalName: options.canonicalName ?? 'weather',
    version: options.version ?? '1.0.0',
    manifest: expected,
    fingerprint: options.fingerprint ?? computeSkillHubFingerprint(expected),
    artifact: await zipEntries(entries),
  }
}

function store(root: string, overrides: Partial<ConstructorParameters<typeof ManagedSkillStore>[0]> = {}): ManagedSkillStore {
  return new ManagedSkillStore({
    root,
    limits: { maxCompressedBytes: 1_000_000, maxExpandedBytes: 1_000_000, maxEntryCount: 20 },
    now: () => new Date('2026-08-26T01:00:00.000Z'),
    ...overrides,
  })
}

async function expectAdmissionError(
  admission: Promise<unknown>,
  code: ManagedSkillAdmissionErrorCode,
): Promise<void> {
  await expect(admission).rejects.toMatchObject({ name: 'ManagedSkillAdmissionError', code })
}

async function expectNoResidue(root: string): Promise<void> {
  expect(await readDirectoryOrEmpty(join(root, 'v1/packages'))).toEqual([])
  expect(await readDirectoryOrEmpty(join(root, 'v1/staging'))).toEqual([])
}

async function readDirectoryOrEmpty(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

async function makeWritable(path: string): Promise<void> {
  let info
  try {
    info = await lstat(path)
  } catch {
    return
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return
  await chmod(path, 0o700)
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) await makeWritable(child)
    else if (entry.isFile()) await chmod(child, 0o600)
  }
}

async function makeReadOnly(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) return
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) await makeReadOnly(child)
    else if (entry.isFile()) await chmod(child, 0o444)
  }
  await chmod(path, 0o555)
}

describe('ManagedSkillStore', () => {
  it('sorts fingerprint inputs by path before formatting rows', () => {
    const files = [
      { path: 'a.txt', sha256: '0'.repeat(64) },
      { path: 'a', sha256: 'f'.repeat(64) },
    ]
    const expected = createHash('sha256')
      .update(`a:${'f'.repeat(64)}\na.txt:${'0'.repeat(64)}\n`)
      .digest('hex')
    expect(computeSkillHubFingerprint(files)).toBe(`sha256:${expected}`)
    expect(computeSkillHubFingerprint([files[0]!, files[0]!])).toMatch(/^sha256:/)
  })

  it('commits a verified root package and receipt as one immutable directory', async () => {
    const root = await tempRoot('managed-skill-valid')
    const files = { 'SKILL.md': skillDocument(), 'scripts/run.sh': '#!/bin/sh\necho weather\n' }
    const input = await release(Object.entries(files).map(([path, content]) => ({ path, content })), { expectedFiles: files })
    const receipt = await store(root).admit(input)

    expect(receipt).toMatchObject({
      formatVersion: 1,
      identity: { registryInstanceId: 'primary', namespace: 'global', slug: 'weather' },
      adapter: 'skillhub',
      sourceServer: 'https://skills.example.test/',
      canonicalName: 'weather',
      version: '1.0.0',
      installedAt: '2026-08-26T01:00:00.000Z',
      enabled: true,
    })
    expect(receipt.manifest).toEqual(manifest(files))
    expect(await readFile(join(receipt.managedLocation, 'scripts/run.sh'), 'utf8')).toBe(files['scripts/run.sh'])
    const packageDirectory = join(receipt.managedLocation, '..')
    expect(JSON.parse(await readFile(join(packageDirectory, 'receipt.json'), 'utf8'))).toEqual(receipt)
    expect(await readdir(join(root, 'v1/staging'))).toEqual([])
    if (process.platform !== 'win32') {
      expect((await stat(receipt.managedLocation)).mode & 0o777).toBe(0o555)
      expect((await stat(join(receipt.managedLocation, 'SKILL.md'))).mode & 0o777).toBe(0o444)
    }
  })

  it('accepts one wrapper directory while persisting root-relative manifest paths', async () => {
    const root = await tempRoot('managed-skill-wrapper')
    const files = { 'SKILL.md': skillDocument(), 'references/help.md': 'Help.\n' }
    const entries = Object.entries(files).map(([path, content]) => ({ path: `weather-1.0.0/${path}`, content }))
    const receipt = await store(root).admit(await release(entries, { expectedFiles: files }))
    expect(receipt.manifest.map(file => file.path)).toEqual(['SKILL.md', 'references/help.md'])
    expect(await readFile(join(receipt.managedLocation, 'references/help.md'), 'utf8')).toBe('Help.\n')
  })

  it('accepts explicit directory entries and non-Unix creator metadata', async () => {
    const root = await tempRoot('managed-skill-directories')
    const files = { 'SKILL.md': skillDocument(), 'references/help.md': 'Help.\n' }
    const receipt = await store(root).admit(await release([
      { path: 'weather/', mode: 0o040755 },
      { path: 'weather/SKILL.md', content: files['SKILL.md'], os: 0, attributes: 0 },
      { path: 'weather/references/', mode: 0o040755 },
      { path: 'weather/references/help.md', content: files['references/help.md'] },
    ], { expectedFiles: files }))
    expect(receipt.manifest.map(file => file.path)).toEqual(['SKILL.md', 'references/help.md'])
  })

  it.each([
    ['/absolute.txt', 'UNSAFE_ARCHIVE_PATH'],
    ['../outside.txt', 'UNSAFE_ARCHIVE_PATH'],
    ['nested/../../outside.txt', 'UNSAFE_ARCHIVE_PATH'],
    ['C:/outside.txt', 'UNSAFE_ARCHIVE_PATH'],
    ['nested\\outside.txt', 'UNSAFE_ARCHIVE_PATH'],
    ['NUL', 'UNSAFE_ARCHIVE_PATH'],
    ['CON.txt', 'UNSAFE_ARCHIVE_PATH'],
    ['COM1.log', 'UNSAFE_ARCHIVE_PATH'],
    ['file:stream', 'UNSAFE_ARCHIVE_PATH'],
    ['trailing. ', 'UNSAFE_ARCHIVE_PATH'],
  ] as const)('rejects unsafe archive path %s', async (path, code) => {
    const root = await tempRoot('managed-skill-path')
    const input = await release([{ path: 'SKILL.md', content: skillDocument() }, { path, content: 'bad' }])
    await expectAdmissionError(store(root).admit(input), code)
    await expectNoResidue(root)
  })

  it.each([
    ['link', 0o120777],
    ['device', 0o060600],
    ['fifo', 0o010600],
  ] as const)('rejects unsafe %s entries', async (_kind, mode) => {
    const root = await tempRoot('managed-skill-special')
    const input = await release([
      { path: 'SKILL.md', content: skillDocument() },
      { path: 'unsafe', content: 'target', mode },
    ])
    await expectAdmissionError(store(root).admit(input), 'UNSAFE_ARCHIVE_ENTRY')
    await expectNoResidue(root)
  })

  it('rejects duplicate central-directory paths', async () => {
    const root = await tempRoot('managed-skill-duplicate')
    const input = await release([
      { path: 'SKILL.md', content: skillDocument() },
      { path: 'SKILL.md', content: skillDocument() },
    ])
    await expectAdmissionError(store(root).admit(input), 'DUPLICATE_ARCHIVE_PATH')
    await expectNoResidue(root)
  })

  it('rejects portable duplicate paths and unsafe dot or empty segments', async () => {
    for (const entries of [
      [{ path: 'SKILL.md', content: skillDocument() }, { path: 'README.md' }, { path: 'readme.md' }],
      [{ path: 'SKILL.md', content: skillDocument() }, { path: './dot.txt' }],
      [{ path: 'SKILL.md', content: skillDocument() }, { path: 'nested//empty.txt' }],
      [{ path: 'SKILL.md', content: skillDocument() }, { path: 'nul\0name.txt' }],
    ]) {
      const root = await tempRoot('managed-skill-portable-path')
      const code = entries.length === 3 ? 'DUPLICATE_ARCHIVE_PATH' : 'UNSAFE_ARCHIVE_PATH'
      await expectAdmissionError(store(root).admit(await release(entries)), code)
      await expectNoResidue(root)
    }
  })

  it('rejects encrypted, unsupported-compression, volume-label, and conflicting entries', async () => {
    const valid = await release([{ path: 'SKILL.md', content: skillDocument() }])
    const encrypted = patchFirstZipEntry(valid.artifact, (data, local, central) => {
      data.writeUInt16LE(data.readUInt16LE(local + 6) | 1, local + 6)
      data.writeUInt16LE(data.readUInt16LE(central + 8) | 1, central + 8)
    })
    const unsupportedCompression = patchFirstZipEntry(valid.artifact, (data, local, central) => {
      data.writeUInt16LE(99, local + 8)
      data.writeUInt16LE(99, central + 10)
    })
    for (const [artifact, code] of [
      [encrypted, 'INVALID_ARCHIVE'],
      [unsupportedCompression, 'UNSAFE_ARCHIVE_ENTRY'],
    ] as const) {
      const root = await tempRoot('managed-skill-unsupported-zip-entry')
      await expectAdmissionError(store(root).admit({ ...valid, artifact }), code)
    }

    for (const entry of [
      { path: 'volume', attributes: 0x08, os: 0 },
      { path: 'directory-as-file', mode: 0o040755 },
      { path: 'file-as-directory/', mode: 0o100644 },
    ]) {
      const root = await tempRoot('managed-skill-conflicting-entry')
      await expectAdmissionError(store(root).admit(await release([
        { path: 'SKILL.md', content: skillDocument() },
        entry,
      ])), 'UNSAFE_ARCHIVE_ENTRY')
    }
  })

  it('rejects empty archives and inconsistent stored-entry size metadata', async () => {
    const emptyRoot = await tempRoot('managed-skill-empty-archive')
    const empty = await release([])
    await expectAdmissionError(store(emptyRoot).admit(empty), 'UNSUPPORTED_PACKAGE_ROOT')

    const sizeRoot = await tempRoot('managed-skill-entry-size')
    const valid = await release([{ path: 'SKILL.md', content: skillDocument() }])
    const artifact = patchFirstZipEntry(valid.artifact, (data, _local, central) => {
      data.writeUInt32LE(data.readUInt32LE(central + 24) + 1, central + 24)
    })
    await expectAdmissionError(store(sizeRoot).admit({ ...valid, artifact }), 'INVALID_ARCHIVE')
  })

  it.each([
    [[{ path: 'README.md', content: 'No skill.' }]],
    [[{ path: 'one/SKILL.md', content: skillDocument() }, { path: 'two/file.txt', content: 'mixed' }]],
    [[{ path: 'SKILL.md', content: skillDocument() }, { path: 'wrapped/SKILL.md', content: skillDocument() }]],
    [[{ path: 'weather/SKILL.md', content: skillDocument() }, { path: 'other/', mode: 0o040755 }]],
  ])('rejects unsupported package roots', async (entries) => {
    const root = await tempRoot('managed-skill-root')
    await expectAdmissionError(store(root).admit(await release(entries)), 'UNSUPPORTED_PACKAGE_ROOT')
    await expectNoResidue(root)
  })

  it('enforces compressed, expanded, and entry count limits before publication', async () => {
    const compressedRoot = await tempRoot('managed-skill-compressed')
    const valid = await release([{ path: 'SKILL.md', content: skillDocument() }])
    await expectAdmissionError(store(compressedRoot, {
      limits: { maxCompressedBytes: valid.artifact.byteLength - 1, maxExpandedBytes: 10_000, maxEntryCount: 10 },
    }).admit(valid), 'ARTIFACT_TOO_LARGE')
    await expectNoResidue(compressedRoot)

    const expandedRoot = await tempRoot('managed-skill-expanded')
    await expectAdmissionError(store(expandedRoot, {
      limits: { maxCompressedBytes: 10_000, maxExpandedBytes: bytes(skillDocument()).byteLength - 1, maxEntryCount: 10 },
    }).admit(valid), 'EXPANDED_SIZE_EXCEEDED')
    await expectNoResidue(expandedRoot)

    const countRoot = await tempRoot('managed-skill-count')
    const twoEntries = await release([
      { path: 'SKILL.md', content: skillDocument() },
      { path: 'README.md', content: 'readme' },
    ])
    const twoFiles = await release([
      { path: 'SKILL.md', content: skillDocument() },
      { path: 'README.md', content: 'readme' },
    ], { expectedFiles: { 'SKILL.md': skillDocument(), 'README.md': 'readme' } })
    await expectAdmissionError(store(countRoot, {
      limits: { maxCompressedBytes: 10_000, maxExpandedBytes: 10_000, maxEntryCount: 1 },
    }).admit(twoEntries), 'TOO_MANY_FILES')
    await expectNoResidue(countRoot)

    const manifestRoot = await tempRoot('managed-skill-manifest-count')
    await expectAdmissionError(store(manifestRoot, {
      limits: { maxCompressedBytes: 10_000, maxExpandedBytes: 10_000, maxEntryCount: 1 },
    }).admit({ ...twoFiles, artifact: Buffer.from('manifest limit must precede ZIP decoding') }), 'TOO_MANY_FILES')
    await expectNoResidue(manifestRoot)

    const exactRoot = await tempRoot('managed-skill-exact-limits')
    const exactDocument = skillDocument('weather')
    const exact = await release([{ path: 'SKILL.md', content: exactDocument }])
    await expect(store(exactRoot, {
      limits: {
        maxCompressedBytes: exact.artifact.byteLength,
        maxExpandedBytes: bytes(exactDocument).byteLength,
        maxEntryCount: 1,
      },
    }).admit(exact)).resolves.toMatchObject({ canonicalName: 'weather' })

    const multibyteRoot = await tempRoot('managed-skill-multibyte-limit')
    const multibyteDocument = `${skillDocument()}\u5929\u6c14\n`
    const multibyte = await release(
      [{ path: 'SKILL.md', content: multibyteDocument }],
      { expectedFiles: { 'SKILL.md': multibyteDocument } },
    )
    await expectAdmissionError(store(multibyteRoot, {
      limits: {
        maxCompressedBytes: multibyte.artifact.byteLength,
        maxExpandedBytes: bytes(multibyteDocument).byteLength - 1,
        maxEntryCount: 1,
      },
    }).admit(multibyte), 'EXPANDED_SIZE_EXCEEDED')
  })

  it('rejects invalid ZIP data, manifest drift, and fingerprint drift', async () => {
    const invalidRoot = await tempRoot('managed-skill-invalid-zip')
    const invalid = await release([{ path: 'SKILL.md', content: skillDocument() }])
    await expectAdmissionError(store(invalidRoot).admit({
      ...invalid,
      artifact: Buffer.from('not a zip'),
    }), 'INVALID_ARCHIVE')
    await expectNoResidue(invalidRoot)

    const manifestRoot = await tempRoot('managed-skill-manifest')
    const wrongManifest = manifest({ 'SKILL.md': `${skillDocument()}changed` })
    const mismatch = await release([{ path: 'SKILL.md', content: skillDocument() }], { expectedManifest: wrongManifest })
    await expectAdmissionError(store(manifestRoot).admit(mismatch), 'MANIFEST_MISMATCH')
    await expectNoResidue(manifestRoot)

    const lengthRoot = await tempRoot('managed-skill-manifest-length')
    const extraManifest = manifest({ 'SKILL.md': skillDocument(), 'missing.txt': 'missing' })
    const missing = await release([{ path: 'SKILL.md', content: skillDocument() }], { expectedManifest: extraManifest })
    await expectAdmissionError(store(lengthRoot).admit(missing), 'MANIFEST_MISMATCH')
    await expectNoResidue(lengthRoot)

    const fingerprintRoot = await tempRoot('managed-skill-fingerprint')
    const expected = manifest({ 'SKILL.md': skillDocument() })
    await expectAdmissionError(store(fingerprintRoot).admit(await release(
      [{ path: 'SKILL.md', content: skillDocument() }],
      { expectedManifest: expected, fingerprint: `sha256:${'0'.repeat(64)}` },
    )), 'FINGERPRINT_MISMATCH')
    await expectNoResidue(fingerprintRoot)
  })

  it('rejects invalid release fields, manifests, limits, and pre-aborted calls', async () => {
    const valid = await release([{ path: 'SKILL.md', content: skillDocument() }])
    const invalidReleases: ManagedSkillRelease[] = [
      { ...valid, identity: { ...valid.identity, registryInstanceId: registryInstanceId('') } },
      { ...valid, identity: { ...valid.identity, namespace: ' padded' } },
      { ...valid, identity: { ...valid.identity, slug: 'nul\0slug' } },
      { ...valid, adapter: '' },
      { ...valid, canonicalName: ' padded' },
      { ...valid, version: 'nul\0version' },
      { ...valid, sourceServer: 'ftp://skills.example.test' },
      { ...valid, sourceServer: 'https://user:secret@skills.example.test' },
      { ...valid, sourceServer: 'not a URL' },
      { ...valid, fingerprint: 'SHA256:invalid' },
      { ...valid, artifact: new Uint8Array() },
      { ...valid, manifest: [], fingerprint: computeSkillHubFingerprint([]) },
      ...['', 'nul\0path', 'back\\slash', 'directory/', '/absolute', 'C:/drive', 'nested//empty', './dot', '../parent', 'NUL', 'CON.txt', 'file:stream', 'trailing. ']
        .map(path => ({ ...valid, manifest: [{ ...valid.manifest[0]!, path }] })),
      { ...valid, manifest: [valid.manifest[0]!, valid.manifest[0]!] },
      { ...valid, manifest: [{ ...valid.manifest[0]!, size: -1 }] },
      { ...valid, manifest: [{ ...valid.manifest[0]!, size: 1.5 }] },
      { ...valid, manifest: [{ ...valid.manifest[0]!, sha256: 'A'.repeat(64) }] },
    ]
    for (const input of invalidReleases) {
      const root = await tempRoot('managed-skill-invalid-request')
      await expectAdmissionError(store(root).admit(input), 'INVALID_REQUEST')
    }
    for (const value of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => store('/unused', {
        limits: { maxCompressedBytes: value, maxExpandedBytes: 10, maxEntryCount: 10 },
      })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    }
    const controller = new AbortController()
    const reason = new Error('already cancelled')
    controller.abort(reason)
    await expect(store(await tempRoot('managed-skill-pre-aborted')).admit(valid, controller.signal)).rejects.toBe(reason)
  })

  it('rejects invalid SKILL.md and catalog identity disagreement', async () => {
    const invalidRoot = await tempRoot('managed-skill-invalid-doc')
    const invalidDocument = 'not frontmatter\n'
    await expectAdmissionError(store(invalidRoot).admit(await release(
      [{ path: 'SKILL.md', content: invalidDocument }],
      { expectedFiles: { 'SKILL.md': invalidDocument } },
    )), 'INVALID_SKILL')
    await expectNoResidue(invalidRoot)

    const identityRoot = await tempRoot('managed-skill-identity')
    const other = skillDocument('other-skill')
    await expectAdmissionError(store(identityRoot).admit(await release(
      [{ path: 'SKILL.md', content: other }],
      { expectedFiles: { 'SKILL.md': other } },
    )), 'IDENTITY_MISMATCH')
    await expectNoResidue(identityRoot)
  })

  it('returns an identical release idempotently without decoding replacement bytes', async () => {
    const root = await tempRoot('managed-skill-idempotent')
    const files = { 'SKILL.md': skillDocument(), 'nested/readme.md': 'nested\n' }
    const input = await release(Object.entries(files).map(([path, content]) => ({ path, content })), { expectedFiles: files })
    const first = await store(root).admit(input)
    const retry = { ...input, artifact: Buffer.from('retry bytes are not decoded') }
    const second = await store(root, { now: () => new Date('2030-01-01T00:00:00Z') }).admit(retry)
    expect(second).toEqual(first)
    expect(await readdir(join(root, 'v1/packages'))).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')('returns a completed admission when lock release fails', async () => {
    const root = await tempRoot('managed-skill-lock-release')
    const input = await release([{ path: 'SKILL.md', content: skillDocument() }])
    const warningEvent = new Promise<Error & { code?: string }>((resolve) => {
      process.once('warning', resolve)
    })
    const receipt = await store(root, {
      now: () => {
        chmodSync(join(root, 'v1'), 0o555)
        return new Date('2026-08-26T01:00:00.000Z')
      },
    }).admit(input)
    expect(receipt.canonicalName).toBe('weather')
    expect(await readFile(join(receipt.managedLocation, 'SKILL.md'), 'utf8')).toBe(skillDocument())
    expect((await lstat(join(root, 'v1/admission.lock'))).isFile()).toBe(true)
    expect((await warningEvent).code).toBe('DSH_MANAGED_SKILL_LOCK_RELEASE')
  })

  it('rejects missing, added, linked, modified, or writable durable package content', async () => {
    const mutations: Array<{
      readonly mutate: (content: string, packagePath: string) => Promise<void>
      readonly leaveWritable?: 'directory' | 'file'
    }> = [
      { mutate: async (content) => {
        await rm(join(content, 'SKILL.md'))
      } },
      { mutate: async (content) => {
        await writeFile(join(content, 'extra.txt'), 'extra')
      } },
      { mutate: async (content) => {
        await mkdir(join(content, 'extra'))
      } },
      { mutate: async (content, packagePath) => {
        await rm(join(content, 'SKILL.md'))
        await symlink(join(packagePath, 'receipt.json'), join(content, 'SKILL.md'))
      } },
      { mutate: async (content) => {
        await writeFile(join(content, 'SKILL.md'), `${skillDocument()}changed\n`)
      } },
      { mutate: async (_content, packagePath) => {
        const receiptPath = join(packagePath, 'receipt.json')
        await rm(receiptPath)
        await symlink(join(packagePath, 'content/SKILL.md'), receiptPath)
      } },
    ]
    if (process.platform !== 'win32') {
      mutations.push(
        { mutate: async () => {}, leaveWritable: 'directory' },
        { mutate: async () => {}, leaveWritable: 'file' },
      )
    }
    for (const { mutate, leaveWritable } of mutations) {
      const root = await tempRoot('managed-skill-corrupt-content')
      const input = await release([{ path: 'SKILL.md', content: skillDocument() }])
      const receipt = await store(root).admit(input)
      const packagePath = join(receipt.managedLocation, '..')
      await makeWritable(packagePath)
      await mutate(receipt.managedLocation, packagePath)
      await makeReadOnly(packagePath)
      if (leaveWritable === 'directory') await chmod(receipt.managedLocation, 0o755)
      if (leaveWritable === 'file') await chmod(join(receipt.managedLocation, 'SKILL.md'), 0o644)
      await expectAdmissionError(store(root).admit(input), 'STORE_CORRUPT')
    }
  })

  it('uses the default clock and permits another version of the same remote identity', async () => {
    const root = await tempRoot('managed-skill-default-clock')
    const files = { 'z.txt': 'z', 'SKILL.md': skillDocument(), 'a.txt': 'a' }
    const input = await release(Object.entries(files).map(([path, content]) => ({ path, content })), {
      expectedManifest: manifest(files).toReversed(),
    })
    const first = await new ManagedSkillStore({
      root,
      limits: { maxCompressedBytes: 10_000, maxExpandedBytes: 10_000, maxEntryCount: 10 },
    }).admit(input)
    expect(Number.isNaN(Date.parse(first.installedAt))).toBe(false)
    const second = await release([{ path: 'SKILL.md', content: skillDocument() }], { version: '2.0.0' })
    await store(root).admit(second)
    expect(await readdir(join(root, 'v1/packages'))).toHaveLength(2)
  })

  it('rejects malformed durable receipt fields and manifests', async () => {
    const mutations: Array<(receipt: Record<string, unknown>) => void> = [
      (receipt) => { receipt.formatVersion = 2 },
      (receipt) => { receipt.enabled = false },
      (receipt) => { receipt.adapter = '' },
      (receipt) => { receipt.adapter = 1 },
      (receipt) => { receipt.sourceServer = 'not a URL' },
      (receipt) => { receipt.sourceServer = 1 },
      (receipt) => { receipt.sourceServer = 'ftp://skills.example.test/' },
      (receipt) => { receipt.sourceServer = 'https://user:secret@skills.example.test/' },
      (receipt) => { receipt.sourceServer = 'https://skills.example.test' },
      (receipt) => { receipt.canonicalName = '' },
      (receipt) => { receipt.version = ' padded' },
      (receipt) => { receipt.fingerprint = 1 },
      (receipt) => { receipt.fingerprint = 'sha256:bad' },
      (receipt) => { receipt.installedAt = 1 },
      (receipt) => { receipt.installedAt = 'not a date' },
      (receipt) => { receipt.managedLocation = '/elsewhere' },
      (receipt) => { receipt.identity = null },
      (receipt) => { (receipt.identity as Record<string, unknown>).registryInstanceId = '' },
      (receipt) => { (receipt.identity as Record<string, unknown>).namespace = ' padded' },
      (receipt) => { (receipt.identity as Record<string, unknown>).slug = 'nul\0slug' },
      (receipt) => { receipt.manifest = {} },
      (receipt) => { receipt.manifest = [] },
      (receipt) => { receipt.manifest = [null] },
      (receipt) => { receipt.manifest = [{ path: 1, size: 1, sha256: '0'.repeat(64) }] },
      (receipt) => { receipt.manifest = [{ path: '../bad', size: 1, sha256: '0'.repeat(64) }] },
      (receipt) => { receipt.manifest = [{ path: 'SKILL.md', size: '1', sha256: '0'.repeat(64) }] },
      (receipt) => { receipt.manifest = [{ path: 'SKILL.md', size: 1.5, sha256: '0'.repeat(64) }] },
      (receipt) => { receipt.manifest = [{ path: 'SKILL.md', size: -1, sha256: '0'.repeat(64) }] },
      (receipt) => { receipt.manifest = [{ path: 'SKILL.md', size: 1, sha256: 1 }] },
      (receipt) => { receipt.manifest = [{ path: 'SKILL.md', size: 1, sha256: 'bad' }] },
      (receipt) => { receipt.manifest = [...(receipt.manifest as unknown[])].reverse() },
      (receipt) => { receipt.fingerprint = `sha256:${'0'.repeat(64)}` },
    ]
    for (const mutate of mutations) {
      const root = await tempRoot('managed-skill-corrupt-field')
      const input = await release([
        { path: 'SKILL.md', content: skillDocument() },
        { path: 'z.txt', content: 'z' },
      ], { expectedFiles: { 'SKILL.md': skillDocument(), 'z.txt': 'z' } })
      const installed = await store(root).admit(input)
      const packagePath = join(installed.managedLocation, '..')
      const receiptPath = join(packagePath, 'receipt.json')
      await makeWritable(packagePath)
      const durable = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>
      mutate(durable)
      await writeFile(receiptPath, `${JSON.stringify(durable)}\n`)
      await makeReadOnly(packagePath)
      await expectAdmissionError(store(root).admit(input), 'STORE_CORRUPT')
    }
  })

  it('rejects unreadable package entries, receipts, roots, and storage keys', async () => {
    const input = await release([{ path: 'SKILL.md', content: skillDocument() }])

    const rootFileRoot = await tempRoot('managed-skill-root-file')
    const rootFile = join(rootFileRoot, 'store')
    await writeFile(rootFile, 'not a directory')
    await expectAdmissionError(store(rootFile).admit(input), 'COMMIT_FAILED')

    const rootLinkRoot = await tempRoot('managed-skill-root-link')
    const rootLinkTarget = join(rootLinkRoot, 'target')
    await mkdir(rootLinkTarget)
    await symlink(rootLinkTarget, join(rootLinkRoot, 'v1'))
    await expectAdmissionError(store(rootLinkRoot).admit(input), 'STORE_CORRUPT')

    const packageFileRoot = await tempRoot('managed-skill-package-file')
    const installed = await store(packageFileRoot).admit(input)
    const packagePath = join(installed.managedLocation, '..')
    await makeWritable(packagePath)
    await rm(packagePath, { recursive: true })
    await writeFile(packagePath, 'not a directory')
    await expectAdmissionError(store(packageFileRoot).admit(input), 'STORE_CORRUPT')

    const packageLinkRoot = await tempRoot('managed-skill-package-link')
    const linked = await store(packageLinkRoot).admit(input)
    const linkedPackage = join(linked.managedLocation, '..')
    await makeWritable(linkedPackage)
    await rm(linkedPackage, { recursive: true })
    await symlink(packageLinkRoot, linkedPackage)
    await expectAdmissionError(store(packageLinkRoot).admit(input), 'STORE_CORRUPT')

    const junkRoot = await tempRoot('managed-skill-store-junk')
    await store(junkRoot).admit(input)
    await writeFile(join(junkRoot, 'v1/packages/junk'), 'junk')
    const versionTwo = await release([{ path: 'SKILL.md', content: skillDocument() }], { version: '2.0.0' })
    await expectAdmissionError(store(junkRoot).admit(versionTwo), 'STORE_CORRUPT')

    const jsonRoot = await tempRoot('managed-skill-invalid-json')
    const jsonReceipt = await store(jsonRoot).admit(input)
    const jsonPackage = join(jsonReceipt.managedLocation, '..')
    await makeWritable(jsonPackage)
    await writeFile(join(jsonPackage, 'receipt.json'), '{invalid')
    await makeReadOnly(jsonPackage)
    await expectAdmissionError(store(jsonRoot).admit(input), 'STORE_CORRUPT')

    const keyRoot = await tempRoot('managed-skill-storage-key')
    const keyReceipt = await store(keyRoot).admit(input)
    const original = join(keyReceipt.managedLocation, '..')
    const wrong = join(keyRoot, 'v1/packages/wrong-key')
    await rename(original, wrong)
    const wrongReceiptPath = join(wrong, 'receipt.json')
    await makeWritable(wrong)
    const wrongReceipt = JSON.parse(await readFile(wrongReceiptPath, 'utf8')) as Record<string, unknown>
    wrongReceipt.managedLocation = join(wrong, 'content')
    await writeFile(wrongReceiptPath, `${JSON.stringify(wrongReceipt)}\n`)
    await makeReadOnly(wrong)
    await expectAdmissionError(store(keyRoot).admit(versionTwo), 'STORE_CORRUPT')
  })

  it('rejects a corrupt durable receipt instead of treating it as an idempotent install', async () => {
    const root = await tempRoot('managed-skill-corrupt-receipt')
    const input = await release([{ path: 'SKILL.md', content: skillDocument() }])
    const receipt = await store(root).admit(input)
    const receiptPath = join(receipt.managedLocation, '..', 'receipt.json')
    await makeWritable(join(receipt.managedLocation, '..'))
    const corrupt = { ...receipt, fingerprint: `sha256:${'0'.repeat(64)}` }
    await writeFile(receiptPath, `${JSON.stringify(corrupt)}\n`)
    await makeReadOnly(join(receipt.managedLocation, '..'))
    await expectAdmissionError(store(root).admit(input), 'STORE_CORRUPT')
  })

  it('rejects immutable release drift and canonical-name ownership conflicts', async () => {
    const immutableRoot = await tempRoot('managed-skill-immutable')
    const input = await release([{ path: 'SKILL.md', content: skillDocument() }])
    await store(immutableRoot).admit(input)
    await expectAdmissionError(store(immutableRoot).admit({ ...input, adapter: 'changed-adapter' }), 'IMMUTABLE_RELEASE_CONFLICT')

    const conflictRoot = await tempRoot('managed-skill-conflict')
    await store(conflictRoot).admit(input)
    const conflicting = await release([{ path: 'SKILL.md', content: skillDocument() }], {
      identity: { namespace: 'other', slug: 'forecast' },
    })
    await expectAdmissionError(store(conflictRoot).admit(conflicting), 'CANONICAL_NAME_CONFLICT')
    expect(await readdir(join(conflictRoot, 'v1/packages'))).toHaveLength(1)
    expect(await readdir(join(conflictRoot, 'v1/staging'))).toEqual([])
  })

  it('cancels extraction with the signal reason and removes staging', async () => {
    const root = await tempRoot('managed-skill-cancel')
    const large = Buffer.alloc(4 * 1024 * 1024, 0x61)
    const files = { 'SKILL.md': skillDocument(), 'assets/large.bin': large }
    const input = await release(Object.entries(files).map(([path, content]) => ({ path, content })), { expectedFiles: files })
    const controller = new AbortController()
    const reason = new Error('transport cancelled')
    const admission = store(root, {
      limits: { maxCompressedBytes: 5_000_000, maxExpandedBytes: 5_000_000, maxEntryCount: 10 },
    }).admit(input, controller.signal)
    setImmediate(() => {
      controller.abort(reason)
    })
    await expect(admission).rejects.toBe(reason)
    await expectNoResidue(root)
  })

  it('leaves no package or receipt when a pre-commit dependency fails', async () => {
    const root = await tempRoot('managed-skill-atomic-failure')
    const input = await release([{ path: 'SKILL.md', content: skillDocument() }])
    await expectAdmissionError(store(root, {
      now: () => { throw new Error('clock unavailable') },
    }).admit(input), 'COMMIT_FAILED')
    await expectNoResidue(root)
  })
})
