import { openRouterProvider } from './openrouter.js'
import type { JevProvider, ProviderName } from './provider.js'
import { typeSafeProvider } from './typesafe.js'

export const PROVIDERS: Record<ProviderName, JevProvider> = {
  openrouter: openRouterProvider,
  typesafe: typeSafeProvider,
}
