import { describe, it, expect } from 'vitest'
import { formTitle, lineRef, shortLabel, sourceLabel, hasDifference, offGolden } from './sources'
import type { GoldenRow } from '@/hooks/use-golden'

const row = (p: Partial<GoldenRow>): GoldenRow => ({ form: 'f1120s', key: 'k', label: '', section: '', line: '22', status: 'agrees', ...p })

describe('all-sources view helpers', () => {
  it('names forms the way they are printed', () => {
    expect(formTitle('f1120s')).toBe('1120-S')
    expect(formTitle('f1125a')).toBe('1125-A')
    expect(formTitle('f1040se')).toBe('Schedule E')
    expect(formTitle('f4562')).toBe('4562')
    expect(lineRef({ form: 'f1120s', section: 'Schedule L', line: '24', col: 'd' })).toBe('1120-S Schedule L line 24 (d)')
  })

  it('shortens the IRS description and the source labels', () => {
    expect(shortLabel('Ordinary business income (loss). Subtract line 21 from line 6')).toBe('Ordinary business income (loss)')
    expect(sourceLabel('proforma 2026-10-15 (815a9144)')).toBe('Proforma 10/15/2026')
    expect(sourceLabel('filed_import 2026-10-14 (0a1b2c3d)')).toBe('Filed import 10/14/2026')
  })

  it('a row differs when any source disagrees, scenarios aside', () => {
    expect(hasDifference(row({ status: 'differs' }))).toBe(true)
    expect(hasDifference(row({ books_differs: true }))).toBe(true)
    expect(hasDifference(row({ golden: 100, returns: { p: { value: 100, where: '' } } }))).toBe(false)
    expect(hasDifference(row({ golden: 100, returns: { p: { value: 150, where: '' } } }))).toBe(true)
    expect(hasDifference(row({ golden: 100, scenarios: { s: { value: 999, where: '' } } }))).toBe(false)
    expect(offGolden(101, 100)).toBe(false)
    expect(offGolden(150, 100)).toBe(true)
    expect(offGolden(undefined, 100)).toBe(false)
  })
})
