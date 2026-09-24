import { defineProvider } from './provider.js'

// TypeSafe direct route (spec 5.1): no extra body fields, cost computed from the list price.
export const typeSafeProvider = defineProvider({
  name: 'typesafe',
  model: 'jev-1.13.0',
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  keyEnv: 'TYPESAFE_API_KEY',
  extraBody: {},
  reportsCost: false,
})
