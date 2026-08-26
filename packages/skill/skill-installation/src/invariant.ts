/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-skill-installation`.
 * @module @deepseek-ai/dsh-skill-installation/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-skill-installation'

/** Cordis companion plugin name. */
export const name = 'skill-installation-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: admission has no service or event stream; package and
 * receipt publication is a filesystem transaction verified at the module API.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
