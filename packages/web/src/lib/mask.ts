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

/**
 * Mask every tax identifier inside free text.
 *
 * The review's evidence strings quote the return they read, header and all:
 * on 2026-10-19 the Group page's open-items list carried 24 full EINs in
 * text like "Schedule L statement, EDGEWATER VENTURES INC 12-3456789". A
 * field holding only an identifier goes through maskTaxId; anything that is
 * prose goes through this. SSN shape (3-2-4, dashes or spaces), EIN shape
 * (2-7) and a bare nine-digit run are masked; amounts (with thousands
 * separators), dates, phone numbers and IRS document locators are left alone.
 */
export function maskTaxIdsInText(text: string | null | undefined): string {
  if (!text) return ''
  return text
    .replace(/(?<![\d-])\d{3}[- ]\d{2}[- ]\d{4}(?![\d-])/g, m => maskTaxId(m))
    .replace(/(?<![\d-])\d{2}-\d{7}(?![\d-])/g, m => maskTaxId(m))
    .replace(/(?<![\d.,-])\d{9}(?![\d,-]|\.\d)/g, m => maskTaxId(m))
}
