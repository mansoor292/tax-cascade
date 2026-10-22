import { describe, it, expect } from 'vitest'
import { safeNext } from './nav'

describe('safeNext', () => {
  it('returns to a page inside the app', () => {
    expect(safeNext('/app/compare/abc?view=sources&year=2024')).toBe('/app/compare/abc?view=sources&year=2024')
    expect(safeNext('/app')).toBe('/app')
  })
  it('refuses anything else', () => {
    for (const bad of [null, '', '/', '//evil.example/app', 'https://evil.example/app', '/application', '/login']) {
      expect(safeNext(bad)).toBeNull()
    }
  })
})
