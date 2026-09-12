import type { ManagedSkillAdmissionErrorCode } from './types.ts'

/** Typed managed-package rejection or storage failure. */
export class ManagedSkillAdmissionError extends Error {
  override readonly name = 'ManagedSkillAdmissionError'

  /**
   * Create one stable failure for later Host error translation.
   * @param message - operator-readable failure without credentials or package content.
   * @param code - machine-readable admission failure.
   * @param options - optional underlying error.
   */
  constructor(
    message: string,
    readonly code: ManagedSkillAdmissionErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/**
 * Preserve typed failures while assigning one code to an owned operation.
 * @param message - operator-readable failure without credentials or package content.
 * @param code - machine-readable admission failure.
 * @param cause - optional underlying failure.
 * @returns never; this helper always throws.
 */
export function fail(message: string, code: ManagedSkillAdmissionErrorCode, cause?: unknown): never {
  throw new ManagedSkillAdmissionError(message, code, cause === undefined ? undefined : { cause })
}
