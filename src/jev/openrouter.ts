import { defineProvider } from './provider.js'

// OpenRouter System One route (spec 5.1), with zero-data-retention routing requested.
export const openRouterProvider = defineProvider({
  name: 'openrouter',
  model: 'typesafe/jev-1.13',
  endpoint: 'https://openrouter.ai/api/v1/systemone',
  keyEnv: 'OPENROUTER_API_KEY',
  extraBody: { provider: { zdr: true, data_collection: 'deny', allow_fallbacks: false } },
  reportsCost: true,
})
