/**
 * Attachment builders for Form 1120-S packages (Schedule D, K-1s, 1125-E, statements).
 * One entry per form; the form's code lives in its own module. See ./types.ts.
 */
import type { AttachmentBuilder } from './types.js'
import { buildStatements1120S } from './statements_1120s.js'
import { buildScheduleD1120S } from './schedule_d_1120s.js'
import { buildK1s1120S } from './k1_1120s.js'

export const builders: AttachmentBuilder[] = [
  buildStatements1120S,
  buildScheduleD1120S,
  buildK1s1120S,
]
