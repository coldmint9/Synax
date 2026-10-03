import { Storage as BrowserStorage } from 'happy-dom'
import * as matchers from '@testing-library/jest-dom/matchers'
import { cleanup } from '@testing-library/react'
import { afterEach, expect, vi } from 'vitest'

if (typeof window !== 'undefined') {
// React Aria assigns to HTMLElement.prototype.focus directly.
// Both jsdom and happy-dom define it as accessor (getter-only).
// We must delete and redefine as a writable data property before any React Aria import.
for (const method of ['focus', 'blur', 'scrollIntoView'] as const) {
  const orig = HTMLElement.prototype[method]
  delete (HTMLElement.prototype as any)[method]
  Object.defineProperty(HTMLElement.prototype, method, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: orig ?? vi.fn(),
  })
}


// Node's experimental global storage is not the browser's Storage implementation.
const browserStorageInstances: BrowserStorage[] = []
for (const key of ['localStorage', 'sessionStorage'] as const) {
  const storage = new BrowserStorage()
  browserStorageInstances.push(storage)
  Object.defineProperty(globalThis, key, { configurable: true, value: storage })
  Object.defineProperty(window, key, { configurable: true, value: storage })
}

// Unit/integration tests must supply their own network fixtures. An omitted API
// mock must never reach the developer's running Synax instance or external hosts.
const nativeFetch = globalThis.fetch.bind(globalThis)
const fixtureOnlyFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (/^(data|blob):/.test(url)) return nativeFetch(input, init)
  throw new Error(`Unmocked network request in frontend test: ${url}. Mock fetch or the API client explicitly.`)
}
globalThis.fetch = fixtureOnlyFetch
window.fetch = fixtureOnlyFetch

expect.extend(matchers)

afterEach(() => {
  cleanup()
  for (const storage of browserStorageInstances) storage.clear()
})

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
})

// React Aria tabs inspect running animations when moving their indicator.
// happy-dom has no Web Animations implementation.
if (!Element.prototype.getAnimations) {
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
}
}
