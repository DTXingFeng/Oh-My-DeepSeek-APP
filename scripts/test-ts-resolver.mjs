import { registerHooks } from 'node:module'

// Keep production .js import paths while Node 24 runs the original .ts modules.
const sourceRoot = new URL('../src/', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && context.parentURL?.startsWith(sourceRoot) && /^\.\.?\//.test(specifier) && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})
