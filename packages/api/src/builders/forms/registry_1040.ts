/**
 * Attachment builders for Form 1040 packages (Schedules 1-3, B, D, E, 8812, 7203, 8995-A, 8959, 8960, 1040-V).
 * One entry per form; the form's code lives in its own module. See ./types.ts.
 */
import type { AttachmentBuilder } from './types.js'
import { buildSchedule1 } from './f1040_sched1.js'
import { buildSchedule1Statement } from './f1040_statements.js'
import { buildSchedule2 } from './f1040_sched2.js'
import { buildSchedule3 } from './f1040_sched3.js'
import { buildScheduleB } from './f1040_schedB.js'
import { buildScheduleD } from './f1040_schedD.js'
import { buildScheduleEK1 } from './f1040_schedE_k1.js'
import { buildSchedule8812 } from './f8812.js'
import { buildForm7203 } from './f7203.js'
import { buildForm8995A } from './f8995a.js'
import { buildForm8959 } from './f8959.js'
import { buildForm8960 } from './f8960.js'
import { buildForm1040V } from './f1040v.js'

export const builders: AttachmentBuilder[] = [
  buildSchedule1,
  buildSchedule1Statement,
  buildSchedule2,
  buildSchedule3,
  buildScheduleB,
  buildScheduleD,
  buildScheduleEK1,
  buildSchedule8812,
  buildForm7203,
  buildForm8995A,
  buildForm8959,
  buildForm8960,
  buildForm1040V,
]
