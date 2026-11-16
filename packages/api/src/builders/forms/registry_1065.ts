/**
 * Attachment builders for Form 1065 packages (partner K-1s). Form 1125-A and
 * the other-deduction / other-income statements are attached by
 * build_return_pdf.ts alongside the corporate returns'.
 */
import type { AttachmentBuilder } from './types.js'
import { buildK1s1065 } from './k1_1065.js'

export const builders: AttachmentBuilder[] = [
  buildK1s1065,
]
