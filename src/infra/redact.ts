const MASK = '[REDACTED]'

// Masks every configured key or token value and any Authorization header value (spec 9.1).
// Every error path and logged provider body goes through this.
export function createRedactor(secrets: (string | undefined)[]): (text: string) => string {
  const values = [
    ...new Set(secrets.filter((secret): secret is string => (secret ?? '').length >= 4)),
  ].sort((a, b) => b.length - a.length)
  return (text) => {
    let redacted = text.replace(
      /(authorization["']?\s*[:=]\s*["']?)(bearer\s+|token\s+)?[^\s"',}]+/gi,
      `$1$2${MASK}`,
    )
    for (const value of values) redacted = redacted.split(value).join(MASK)
    return redacted
  }
}
