import { AxiError } from 'axi-sdk-js'

// Stable error codes (spec 4.2) and the exit code each one maps to.
export const EXIT_CODES = {
  VALIDATION_ERROR: 2,
  PRIVATE_REPO_NOT_ALLOWED: 2,
  BUDGET_STOP: 3,
  MISSING_KEY: 4,
  CONFIG_PERMISSIONS: 4,
  PROVIDER_AUTH: 4,
  PROVIDER_CREDITS: 4,
  PROVIDER_RATE_LIMIT: 4,
  PROVIDER_ERROR: 4,
  INVALID_RESPONSE: 4,
  MISSING_GITHUB_TOKEN: 4,
  GITHUB_AUTH: 4,
  GITHUB_NOT_FOUND: 4,
  GITHUB_RATE_LIMIT: 4,
  GITHUB_ERROR: 4,
  UNKNOWN: 1,
} as const

export type ErrorCode = keyof typeof EXIT_CODES

export class QuietReviewError extends AxiError {
  declare readonly code: ErrorCode

  constructor(code: ErrorCode, message: string, help: string[] = []) {
    super(message, code, help)
    this.name = 'QuietReviewError'
  }
}

export function exitCodeFor(code: string): number {
  return EXIT_CODES[code as ErrorCode] ?? 1
}

export function validationError(message: string, help: string[] = []) {
  return new QuietReviewError('VALIDATION_ERROR', message, help)
}
