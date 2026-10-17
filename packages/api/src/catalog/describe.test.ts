import { describe as suite, it, expect } from 'vitest'
import { describe, lineFromContainer, type DescContext } from './describe.js'

// Real accessibility texts from IRS blanks (1120-S 2024, 1040 2023, Sch E 2023).
function run(rows: Array<[string, string[]?]>) {
  const ctx: DescContext = { section: '', line: '' }
  return rows.map(([d, c]) => describe(d, c ?? [], ctx))
}

suite('describe — IRS accessibility text to box location', () => {
  it('page 1 lines and lettered items', () => {
    const [a, b, c, d] = run([
      ['Page 1. For calendar year 2024 or tax year beginning. Month and day.'],
      ['A. S election effective date.'],
      ['1b. Less returns and allowances.'],
      ['Deductions (see instructions for limitations). 7. Compensation of officers (see instructions—attach Form 1125-E).'],
    ])
    expect(a.line).toBe('')
    expect(b.line).toBe('A')
    expect(b.label).toMatch(/S election effective date/)
    expect(c.line).toBe('1b')
    expect(c.label).toBe('Less returns and allowances')
    expect(d.line).toBe('7')
    expect(d.label).toMatch(/^Compensation of officers/)
  })

  it('J (1)/(2) check items', () => {
    const [j1] = run([['J. Check if corporation: (1). Aggregated activities for section 465 at-risk purposes.']])
    expect(j1.line).toBe('J(1)')
  })

  it('Schedule L rows are lines; column letter kept; section announced once', () => {
    const [cash, cashD, loans] = run([
      ['Schedule L. Balance Sheets per Books. Assets. Row: 1. Cash. Column: Beginning of tax year. (a).'],
      ['Row: 1. Cash. Column: End of tax year. (d).'],
      ['Row: 19. Loans from shareholders. Column: End of tax year. (d).'],
    ])
    expect(cash.section).toBe('Schedule L')
    expect(cash.line).toBe('1')
    expect(cash.col).toBe('a')
    expect(cashD.col).toBe('d')
    expect(loans.section).toBe('Schedule L')
    expect(loans.line).toBe('19')
    expect(loans.col).toBe('d')
    expect(loans.label).toMatch(/Loans from shareholders/)
  })

  it('Schedule K continuation on page 4', () => {
    const [k] = run([['Page 4. Schedule K. Shareholders\' Pro Rata Share Items (continued). Other Information. 17a. Investment income. Total amount.']])
    expect(k.section).toBe('Schedule K')
    expect(k.line).toBe('17a')
  })

  it('Schedule E Part II table: line from the container, row letter, column letter', () => {
    const [first, h, k] = run([
      ['28. Row: A. Column: (a) Name.', ['Page2', 'Table_Line28a-f', 'RowA']],
      ['Row: A. Column: Passive Income and Loss. (h) Passive income from Schedule K-1.', ['Page2', 'Table_Line28g-k', 'RowA']],
      ['Row: A. Column: Nonpassive Income and Loss. (k) Nonpassive income from Schedule K-1.', ['Page2', 'Table_Line28g-k', 'RowA']],
    ])
    expect(first.line).toBe('28')
    expect(first.row).toBe('A')
    expect(first.col).toBe('a')
    expect(h.line).toBe('28')
    expect(h.row).toBe('A')
    expect(h.col).toBe('h')
    expect(k.col).toBe('k')
  })

  it('Part II announced as "Part I I"', () => {
    const [p] = run([['Caution: The I R S compares amounts reported on your tax return with amounts shown on Schedule(s) K-1. Part I I. Income or Loss From Partnerships and S Corporations. 27. Are you reporting any loss not allowed in a prior year? Yes.']])
    expect(p.section).toBe('Part II')
    expect(p.line).toBe('27')
  })

  it('dependents table rows are not lines', () => {
    const [r] = run([['Dependents (see instructions). Row: 1. Column: (1) First name. Last name.']])
    expect(r.row).toBe('1')
    expect(r.col).toBe('1')
  })

  it('first sub-item spoken inside the line text', () => {
    const [w, d] = run([
      ['25. Federal income tax withheld from: a. Form(s) W-2.'],
      ['5. Dividends: a. Ordinary dividends.'],
    ])
    expect(w.line).toBe('25a')
    expect(d.line).toBe('5a')
  })

  it('lettered items: sub-boxes, digits, tables, beginning/end', () => {
    const [h1, h2, k1, k1b, l1, lrow, i1, i2] = run([
      ['H. Check if: (1). Final return.'],
      ['H. (2). Name change.'],
      ['K1. Partner’s share of liabilities. Row: Nonrecourse. Column: Beginning. $.'],
      ['Row: Nonrecourse. Column: Ending. $.'],
      ['L. Partner\'s capital account analysis: Row: Beginning capital account. $.'],
      ['L. Row: Withdrawals and distributions. Column: Open parenthesis. Close parenthesis. $.'],
      ['I. Loans from shareholder. Beginning of tax year. $.'],
      ['I. End of tax year. $.'],
    ])
    expect(h1.line).toBe('H(1)')
    expect(h2.line).toBe('H(2)')
    expect([k1.line, k1.row, k1.col]).toEqual(['K1', 'Nonrecourse', 'beginning'])
    expect([k1b.line, k1b.col]).toEqual(['K1', 'end'])
    expect([l1.line, l1.row]).toEqual(['L', 'Beginning capital account'])
    expect([lrow.line, lrow.row]).toEqual(['L', 'Withdrawals and distributions'])
    expect([i1.line, i1.col]).toEqual(['I', 'beginning'])
    expect([i2.line, i2.col]).toEqual(['I', 'end'])
  })

  it('sub-letters continue the numbered line; 1125-E entries are rows', () => {
    const [a, b, c, e] = run([
      ['1. Check accounting method: a. Cash.'],
      ['b. Accrual.'],
      ['c. Other (specify).'],
      ['Line 1. Entry 2. (f) Amount of compensation.'],
    ])
    expect([a.line, b.line, c.line]).toEqual(['1a', '1b', '1c'])
    expect([e.line, e.row, e.col]).toEqual(['1', '2', 'f'])
  })

  it('numbered sub-boxes of a lettered item; re-spoken line before a sub-letter', () => {
    const [a1, a3, b2] = run([
      ['A. Check if: 1a. Consolidated return (attach Form 851).'],
      ['A. 3. Personal service corp. (see instructions).'],
      ['2. b. Product or service.'],
    ])
    expect(a1.line).toBe('A(1a)')
    expect(a3.line).toBe('A(3)')
    expect(b2.line).toBe('2b')
    const [i] = run([['I. Number of Schedules K-1. Attach one for each person who was a partner.']])
    expect(i.line).toBe('I')
  })

  it('container names', () => {
    expect(lineFromContainer(['Page1', 'Line6_ReadOrder'])).toBe('6')
    expect(lineFromContainer(['Page1', 'Line1a_ReadOrder'])).toBe('1a')
    expect(lineFromContainer(['Page2', 'Table_Line28a-f', 'RowA'])).toBe('28')
    expect(lineFromContainer(['Page1', 'Address_ReadOrder'])).toBe('')
  })
})
