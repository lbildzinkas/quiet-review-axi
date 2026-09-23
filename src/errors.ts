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

export interface ErrorDetails {
  // Provider HTTP status and response body, kept for the call log (redacted there).
  providerStatus?: number
  providerBody?: string
}

export class QuietReviewError extends AxiError {
  declare readonly code: ErrorCode
  readonly providerStatus?: number
  readonly providerBody?: string

  constructor(code: ErrorCode, message: string, help: string[] = [], details: ErrorDetails = {}) {
    super(message, code, help)
    this.name = 'QuietReviewError'
    this.providerStatus = details.providerStatus
    this.providerBody = details.providerBody
  }
}

export function exitCodeFor(code: string): number {
  return EXIT_CODES[code as ErrorCode] ?? 1
}

export function validationError(message: string, help: string[] = []) {
  return new QuietReviewError('VALIDATION_ERROR', message, help)
}

// A run stopped at --max-cost: the partial result is already rendered and goes to stdout
// with exit 3 (spec 9.4).
export class BudgetStop extends QuietReviewError {
  constructor(readonly renderedOutput: string) {
    super('BUDGET_STOP', 'Stopped at --max-cost')
    this.name = 'BudgetStop'
  }
}
