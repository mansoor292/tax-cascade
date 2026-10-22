/**
 * The tax year a form opens on.
 *
 * Seven year pickers (Compute, the Compute Return dialog, Scenarios,
 * Extensions, QuickBooks, Tax Tables, Cascade) were hardcoded to 2024, so
 * from January 2026 every one of them opened on a year already filed while
 * the owner was preparing 2025 (UI audit, 2026-10-22). The year being
 * prepared is last calendar year; a picker's options stop at the newest year
 * the engine knows, so the default is the newest option no later than that.
 */
export const TAX_YEARS = [2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018]

export function filingYear(options: number[] = TAX_YEARS, today: Date = new Date()): number {
  const want = today.getFullYear() - 1
  const ok = options.filter(y => y <= want)
  return ok.length ? Math.max(...ok) : Math.min(...options)
}
