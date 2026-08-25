/** Package-owned invariant companion for the Skill Center client contribution. */
/* jscpd:ignore-start */
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Context } from '@deepseek-ai/cordis'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-skill-center'
export const name = 'client-ui-skill-center-invariant'
export const inject = ['invariants']
/**
 * No runtime invariant: the page and sidebar action are slot registrations,
 * while their disposal and connection use are covered by the assembled tests.
 */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
