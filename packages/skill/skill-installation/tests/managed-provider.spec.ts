import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { ManagedSkillProvider, apply, registryInstanceId, type ManagedInstallationService } from '../src/index.ts'
import type { ManagedSkillReceipt } from '../src/types.ts'

async function fixture(enabled: boolean): Promise<ManagedSkillReceipt> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-provider-'))
  const content = join(root, 'content')
  await mkdir(content)
  await writeFile(join(content, 'SKILL.md'), '---\nname: managed-demo\ndescription: Managed demo\n---\n\nUse it.\n')
  return {
    formatVersion: 1,
    identity: { registryInstanceId: registryInstanceId('test'), namespace: 'acme', slug: 'demo' },
    adapter: 'skillhub',
    sourceServer: 'https://private.example.test',
    canonicalName: 'managed-demo',
    version: '1.0.0',
    manifest: [],
    fingerprint: 'sha256:' + '0'.repeat(64),
    installedAt: new Date(0).toISOString(),
    enabled,
    managedLocation: content,
  }
}

describe('ManagedSkillProvider', () => {
  it('lists enabled receipts and loads SKILL.md without leaking host fields', async () => {
    const enabled = await fixture(true)
    const disabled = await fixture(false)
    const service = { listReceipts: vi.fn(async () => [enabled, disabled]) } as unknown as ManagedInstallationService
    const provider = new ManagedSkillProvider(service)
    const candidates = await provider.list({})
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).not.toHaveProperty('path')
    expect(candidates[0]).not.toHaveProperty('sourceServer')
    const definition = await provider.get(candidates[0]!, {})
    expect(definition).toMatchObject({ name: 'managed-demo', content: 'Use it.', provider: 'managed' })
    expect(definition?.resourceBase).toEqual({ kind: 'opaque', description: 'Resources are managed by the local Skill Center.' })
    expect(definition).not.toHaveProperty('path')
  })

  it('registers on ctx.skills and invalidates on lifecycle changes', async () => {
    const receipt = await fixture(true)
    const listeners: Array<() => void> = []
    const service = {
      listReceipts: vi.fn(async () => [receipt]),
      onChange: vi.fn((listener: () => void) => { listeners.push(listener); return () => {} }),
    } as unknown as ManagedInstallationService
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const dispose = apply(ctx, service)
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['managed-demo'])
    listeners[0]!()
    expect(ctx.events).toBeDefined()
    dispose()
    expect(await ctx.skills.list()).toEqual([])
  })
})
