/**
 * Attachment builders for Form 1120 packages (Schedule O, 1125-E, 2220, statements).
 * One entry per form; the form's code lives in its own module. See ./types.ts.
 */
import type { AttachmentBuilder } from './types.js'
import { buildStatements1120 } from './statements_1120.js'
import { buildScheduleG } from './form_1120_schedule_g.js'
import { buildScheduleO } from './form_1120_schedule_o.js'
import { buildForm2220 } from './form_2220.js'
import { buildForm4562 } from './form_4562.js'

export const builders: AttachmentBuilder[] = [
  buildStatements1120,
  buildScheduleG,
  buildScheduleO,
  buildForm2220,
  buildForm4562,
]
