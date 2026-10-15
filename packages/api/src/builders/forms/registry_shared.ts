/**
 * Attachment builders shared by BOTH corporate families (1120 and 1120-S),
 * e.g. Form 1125-E. Registered once here instead of in two registries.
 * See ./types.ts.
 */
import type { AttachmentBuilder } from './types.js'
import { buildForm1125E } from './form_1125e.js'

export const builders: AttachmentBuilder[] = [
  buildForm1125E,
]
