import * as matchers from '@testing-library/jest-dom/matchers'
import { cleanup } from '@testing-library/react'
import { afterEach, expect, vi } from 'vitest'

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


expect.extend(matchers)

afterEach(() => {
  cleanup()
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
