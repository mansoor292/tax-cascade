/**
 * Attachment builders for state returns attached to a federal package (NY IT-203 set, FL F-1120).
 * One entry per form; the form's code lives in its own module. See ./types.ts.
 *
 * These run for EVERY return family, so each builder gates on its own data
 * (input_data.state_*) and returns null when the return carries none.
 */
import type { AttachmentBuilder } from './types.js'
import { buildNyIt203, buildNyIt203b, buildNyIt2 } from './state_ny.js'

export const builders: AttachmentBuilder[] = [
  buildNyIt203,
  buildNyIt203b,
  buildNyIt2,
]
