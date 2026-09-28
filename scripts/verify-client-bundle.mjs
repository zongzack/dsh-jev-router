import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const PLUGIN_ID = '@asi-ai/dsh-jev-router'
const bundleUrl = new URL('../lib/client.js', import.meta.url)
const source = await readFile(bundleUrl, 'utf8')
let registration

const context = vm.createContext({
  window: {
    __ModuleLoader__: {
      load(value) {
        registration = value
      },
    },
  },
})

new vm.Script(source, { filename: bundleUrl.pathname }).runInContext(context)

if (registration?.id !== PLUGIN_ID) {
  throw new Error(`client bundle registered ${String(registration?.id)} instead of ${PLUGIN_ID}`)
}
if (typeof registration.factory !== 'function') {
  throw new Error('client bundle did not register a lazy factory')
}

const modules = new Map([
  ['react', await import('react')],
  ['react/jsx-runtime', await import('react/jsx-runtime')],
])
const exports = registration.factory(specifier => {
  if (!modules.has(specifier)) throw new Error(`client bundle requested unexpected module ${specifier}`)
  return modules.get(specifier)
})
if (typeof exports.apply !== 'function') {
  throw new Error('client bundle factory did not export apply')
}
if (!Array.isArray(exports.inject) || exports.inject.some(value => typeof value !== 'string')) {
  throw new Error('client bundle factory did not export a string inject list')
}

console.log(`verified dsh Client Modules bundle: ${PLUGIN_ID}`)
