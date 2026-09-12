import { access, chmod, lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import { computeSkillHubFingerprint, ManagedSkillStore, registryInstanceId } from '../src/index.ts'

const fixtureDir = dirname(fileURLToPath(import.meta.url))
const configPath = join(fixtureDir, 'fixtures', 'managed-provider.cordis.yml')
const binScript = join(fixtureDir, 'fixtures', 'managed-provider-bin.ts')
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

async function makeWritable(path: string): Promise<void> {
  const info = await lstat(path)
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) await makeWritable(join(path, entry))
    await chmod(path, 0o700)
  } else {
    await chmod(path, 0o600)
  }
}

describe('ManagedSkillProvider real Loader composition', () => {
  it('publishes parsed managed skill metadata and content through ctx.skills', async () => {
    const result = await runLoaderSmoke({
      label: 'managed provider composition',
      tempDirPrefix: 'dsh-managed-provider-loader-',
      binScript,
      configPath,
      tsconfigPath,
      processTimeoutMs: LOADER_SMOKE_TEST_TIMEOUT_MS,
      prepare: async (cwd) => {
        const content = join(cwd, 'managed', 'content')
        await mkdir(content, { recursive: true })
        await writeFile(join(content, 'SKILL.md'), '---\nname: managed-demo\ndescription: Loader managed demo\n---\n\nLoaded through Loader.\n')
      },
    })
    const output = JSON.parse(result.stdout) as {
      complete: boolean
      skills: { name: string; description: string; provider: string }[]
      content?: string
    }
    expect(output).toMatchInlineSnapshot(`
      {
        "complete": true,
        "content": "Loaded through Loader.",
        "skills": [
          {
            "description": "Loader managed demo",
            "invocation": {
              "modelInvocable": true,
              "userInvocable": true,
            },
            "name": "managed-demo",
            "provider": "managed",
            "resourceBase": {
              "description": "Resources are managed by the local Skill Center.",
              "kind": "opaque",
            },
            "source": "custom",
          },
        ],
      }
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('reconciles an admitted package and removes abandoned staging before registry discovery', async () => {
    const document = '---\nname: managed-demo\ndescription: Recovered managed demo\n---\n\nRecovered after restart.\n'
    const bytes = Buffer.from(document, 'utf8')
    const manifest = [{
      path: 'SKILL.md',
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }]
    const release = {
      identity: { registryInstanceId: registryInstanceId('fixture'), namespace: 'fixture', slug: 'managed-demo' },
      adapter: 'fixture',
      sourceServer: 'https://fixture.example.test',
      canonicalName: 'managed-demo',
      version: '1.0.0',
      manifest,
      fingerprint: computeSkillHubFingerprint(manifest),
      artifact: Buffer.from(zipSync({ 'SKILL.md': bytes })),
    }
    const result = await runLoaderSmoke({
      label: 'managed provider restart reconciliation',
      tempDirPrefix: 'dsh-managed-provider-reconcile-',
      binScript,
      configPath,
      tsconfigPath,
      processTimeoutMs: LOADER_SMOKE_TEST_TIMEOUT_MS,
      env: { MANAGED_PROVIDER_REAL: '1' },
      prepare: async (cwd) => {
        // Admit before the subprocess starts; its fresh service instance then
        // reconciles the same durable store during startup.
        const actualCwd = await realpath(cwd)
        const store = new ManagedSkillStore({
          root: join(actualCwd, 'managed-store'),
          limits: { maxCompressedBytes: 1_000_000, maxExpandedBytes: 1_000_000, maxEntryCount: 10 },
        })
        await store.admit(release)
        const abandoned = join(store.root, 'staging', 'abandoned')
        await mkdir(abandoned, { recursive: true })
        await writeFile(join(abandoned, 'partial.tmp'), 'partial')
      },
      inspect: async (cwd) => {
        await expect(access(join(cwd, 'managed-store', 'v1', 'staging', 'abandoned'))).rejects.toMatchObject({ code: 'ENOENT' })
        await makeWritable(join(cwd, 'managed-store'))
      },
    })
    expect(JSON.parse(result.stdout)).toMatchInlineSnapshot(`
      {
        "complete": true,
        "content": "Recovered after restart.",
        "skills": [
          {
            "description": "Recovered managed demo",
            "invocation": {
              "modelInvocable": true,
              "userInvocable": true,
            },
            "name": "managed-demo",
            "provider": "managed",
            "resourceBase": {
              "description": "Resources are managed by the local Skill Center.",
              "kind": "opaque",
            },
            "source": "custom",
          },
        ],
      }
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
