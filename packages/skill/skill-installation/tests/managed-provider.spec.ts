import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { ManagedSkillProvider, apply, registryInstanceId, type ManagedInstallationService } from '../src/index.ts'
import type { ManagedSkillReceipt } from '../src/types.ts'

async function fixture(enabled: boolean, document = '---\nname: managed-demo\ndescription: Managed demo\n---\n\nUse it.\n'): Promise<ManagedSkillReceipt> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-provider-'))
  const content = join(root, 'content')
  await mkdir(content)
  await writeFile(join(content, 'SKILL.md'), document)
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
  it('lists enabled receipts with the parsed invocation policy and loads SKILL.md without leaking host fields', async () => {
    const enabled = await fixture(true, '---\nname: managed-demo\ndescription: Parsed managed demo\nwhenToUse: Use for managed demos\ndisable-model-invocation: true\nuser-invocable: false\n---\n\nUse it.\n')
    const disabled = await fixture(false)
    const service = { listReceipts: vi.fn(async () => [enabled, disabled]) } as unknown as ManagedInstallationService
    const provider = new ManagedSkillProvider(service)
    const listed = await provider.list({})
    expect(Array.isArray(listed)).toBe(true)
    if ('complete' in listed) throw new Error('expected complete managed provider discovery')
    const candidates = listed
    expect(candidates).toHaveLength(1)
    const candidate = candidates[0]
    if (candidate === undefined) throw new Error('expected a managed skill candidate')
    expect(candidate).toMatchObject({
      description: 'Parsed managed demo',
      whenToUse: 'Use for managed demos',
      invocation: { modelInvocable: false, userInvocable: false },
      resourceBase: { kind: 'opaque', description: 'Resources are managed by the local Skill Center.' },
    })
    expect(candidate).not.toHaveProperty('path')
    expect(candidate).not.toHaveProperty('sourceServer')
    const definition = await provider.get(candidate, {})
    expect(definition).toMatchObject({
      name: 'managed-demo',
      description: 'Parsed managed demo',
      whenToUse: 'Use for managed demos',
      invocation: { modelInvocable: false, userInvocable: false },
      content: 'Use it.',
      provider: 'managed',
    })
    expect(definition?.resourceBase).toEqual({ kind: 'opaque', description: 'Resources are managed by the local Skill Center.' })
    expect(definition).not.toHaveProperty('path')
  })

  it('does not load a stale candidate after its installation is disabled', async () => {
    const enabled = await fixture(true)
    const disabled = { ...enabled, enabled: false }
    const service = {
      listReceipts: vi.fn()
        .mockResolvedValueOnce([enabled])
        .mockResolvedValueOnce([disabled]),
    } as unknown as ManagedInstallationService
    const provider = new ManagedSkillProvider(service)
    const listed = await provider.list({})
    expect(Array.isArray(listed)).toBe(true)
    if ('complete' in listed) throw new Error('expected complete managed provider discovery')
    const candidate = listed[0]
    if (candidate === undefined) throw new Error('expected a managed skill candidate')

    await expect(provider.get(candidate, {})).resolves.toBeUndefined()
  })

  it('keeps valid candidates visible while reporting a failed managed discovery as incomplete', async () => {
    const valid = await fixture(true)
    const missing = { ...valid, canonicalName: 'missing-skill', managedLocation: join(tmpdir(), 'missing-skill') }
    const service = { listReceipts: vi.fn(async () => [valid, missing]) } as unknown as ManagedInstallationService
    const reportFailure = vi.fn()
    const provider = new ManagedSkillProvider(service, undefined, reportFailure)

    await expect(provider.list({})).resolves.toEqual({
      candidates: [expect.objectContaining({ name: 'managed-demo' })],
      complete: false,
    })
    expect(reportFailure).toHaveBeenCalledWith(expect.any(Error))
  })

  it('registers on ctx.skills and invalidates on lifecycle changes', async () => {
    const receipt = await fixture(true)
    const listeners: Array<() => void> = []
    let current: readonly ManagedSkillReceipt[] = [receipt]
    const service = {
      listReceipts: vi.fn(async () => current),
      onChange: vi.fn((listener: () => void) => { listeners.push(listener); return () => {} }),
    } as unknown as ManagedInstallationService
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const dispose = apply(ctx, service)
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['managed-demo'])
    current = [{ ...receipt, enabled: false }]
    listeners[0]!()
    expect(await ctx.skills.list()).toEqual([])
    dispose()
    expect(await ctx.skills.list()).toEqual([])
  })

  it('keeps managed skills below runtime and local overrides but above bundled skills', async () => {
    const receipt = await fixture(true)
    const service = {
      listReceipts: vi.fn(async () => [receipt]),
      onChange: vi.fn(() => () => {}),
    } as unknown as ManagedInstallationService
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const disposeManaged = apply(ctx, service)
    const registerSynthetic = (name: string, source: 'project-agents' | 'user-agents' | 'custom' | 'bundled', rank: number, description: string) => ctx.skills.registerProvider(() => ({
      name,
      list: async () => [{
        name: 'managed-demo',
        description,
        invocation: { modelInvocable: true, userInvocable: true },
        source,
        provider: name,
        rank,
        locator: undefined,
      }],
      get: async () => undefined,
    }))
    const disposeBundled = registerSynthetic('bundled', 'bundled', 600, 'Bundled demo')
    const disposeUser = registerSynthetic('user', 'user-agents', 500, 'User demo')
    const disposeProject = registerSynthetic('project', 'project-agents', 200, 'Project demo')
    expect((await ctx.skills.list()).find(skill => skill.name === 'managed-demo')?.provider).toBe('project')

    const disposeCustom = registerSynthetic('custom', 'custom', 300, 'Custom demo')
    disposeProject()
    expect((await ctx.skills.list()).find(skill => skill.name === 'managed-demo')?.provider).toBe('custom')

    disposeCustom()
    expect((await ctx.skills.list()).find(skill => skill.name === 'managed-demo')?.provider).toBe('user')

    disposeUser()
    expect((await ctx.skills.list()).find(skill => skill.name === 'managed-demo')?.provider).toBe('managed')

    const disposeRuntime = ctx.skills.register({
      name: 'managed-demo',
      description: 'Runtime demo',
      content: 'Runtime demo',
      source: 'runtime',
    })
    expect((await ctx.skills.list()).find(skill => skill.name === 'managed-demo')?.provider).toBe('runtime')

    disposeRuntime()
    disposeBundled()
    disposeManaged()
  })
})
