import { homedir } from 'node:os'
import { join } from 'node:path'

type Env = Record<string, string | undefined>

// XDG base directories (spec 9), falling back to the documented defaults under HOME.
function base(env: Env, variable: string, fallback: string[]): string {
  const value = env[variable]
  if (value) return value
  return join(env.HOME ?? homedir(), ...fallback)
}

export function userConfigPath(env: Env): string {
  return join(base(env, 'XDG_CONFIG_HOME', ['.config']), 'quiet-review-axi', 'config.json')
}

export function cacheDir(env: Env): string {
  return join(base(env, 'XDG_CACHE_HOME', ['.cache']), 'quiet-review-axi', 'jev')
}

// The replay label model's chat responses (spec 10.6), cached like Jev responses (spec 9.2).
export function labelCacheDir(env: Env): string {
  return join(base(env, 'XDG_CACHE_HOME', ['.cache']), 'quiet-review-axi', 'label-check')
}

export function callLogPath(env: Env): string {
  return join(base(env, 'XDG_STATE_HOME', ['.local', 'state']), 'quiet-review-axi', 'calls.jsonl')
}

export const REPO_CONFIG_FILE = '.quiet-review.json'
