import { createHash } from 'node:crypto'
import type { VerifiedSkillFile } from './types.ts'

/**
 * Recompute SkillHub's version fingerprint from verified files. SkillHub sorts
 * paths by Java string order, appends `path:sha256\n` for each file, hashes the
 * complete UTF-8 sequence, and prefixes the lowercase digest with `sha256:`.
 * @param files - verified path and lowercase SHA-256 pairs.
 * @returns the SkillHub-compatible version fingerprint.
 */
export function computeSkillHubFingerprint(files: readonly Pick<VerifiedSkillFile, 'path' | 'sha256'>[]): string {
  const digest = createHash('sha256')
  const sorted = [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  for (const file of sorted) digest.update(`${file.path}:${file.sha256}\n`, 'utf8')
  return `sha256:${digest.digest('hex')}`
}
