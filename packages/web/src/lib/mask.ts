/**
 * Hide all but the last four digits of a tax identifier.
 *
 * Reported during testing: a full Social Security number was shown under every
 * document in ordinary navigation. Someone reviewing their own vault does not
 * need it spelled out, and may well be showing that screen to an accountant,
 * a family member or a vendor who has no business seeing it.
 *
 * The separator shape is preserved so the value is still recognisable as an
 * SSN or an EIN: 123-45-6789 -> •••-••-6789, 12-3456789 -> ••-•••6789.
 */
export function maskTaxId(value: string | null | undefined): string {
  if (!value) return ''
  const digits = value.replace(/\D/g, '')
  if (digits.length < 4) return '•'.repeat(value.length)
  const last4 = digits.slice(-4)

  // Rebuild the original shape, revealing only the final four digits.
  let seen = 0
  const total = digits.length
  return value
    .split('')
    .map(ch => {
      if (!/\d/.test(ch)) return ch
      seen++
      return seen > total - 4 ? last4[4 - (total - seen) - 1] : '•'
    })
    .join('')
}
