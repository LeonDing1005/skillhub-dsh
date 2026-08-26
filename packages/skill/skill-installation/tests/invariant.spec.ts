import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SkillInstallationInvariant from '../src/invariant.ts'

describe('skill-installation invariant companion', () => {
  it('registers its explained empty runtime invariant', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(SkillInstallationInvariant)

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-skill-installation', () => {})
    }).toThrow(/already registered/)
    await fiber.dispose()
    const dispose = ctx.invariants.register('@deepseek-ai/dsh-skill-installation', () => {})
    dispose()
    await ctx.fiber.dispose()
  })
})
