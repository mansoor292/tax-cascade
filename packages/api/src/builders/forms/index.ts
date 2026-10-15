/**
 * All registered attachment builders, by the return's form type. See ./types.ts.
 * Each family keeps its own registry file so parallel work never edits one list.
 */
import type { Attachment, AttachmentContext, AttachmentBuilder } from './types.js'
import { builders as b1120s } from './registry_1120s.js'
import { builders as b1120 } from './registry_1120.js'
import { builders as b1040 } from './registry_1040.js'
import { builders as bState } from './registry_state.js'
import { builders as bShared } from './registry_shared.js'

const BY_FORM: Record<string, AttachmentBuilder[]> = {
  '1120S': [...bShared, ...b1120s],
  '1120': [...bShared, ...b1120],
  '1040': b1040,
}

/** Run every builder registered for the return's form type, sorted by attachment sequence. */
export async function buildAttachments(ctx: AttachmentContext): Promise<Attachment[]> {
  const out: Attachment[] = []
  for (const build of [...(BY_FORM[ctx.formType] || []), ...bState]) {
    try {
      const got = await build(ctx)
      if (!got) continue
      for (const a of Array.isArray(got) ? got : [got]) if (a?.pdf) out.push(a)
    } catch (e: any) {
      // One broken attachment must not take the whole package down with it,
      // but it must be loud: a silently missing form is the bug this replaced.
      console.error(`[attachments] ${ctx.formType} ${ctx.taxYear}: ${e?.message || e}`)
    }
  }
  return out.sort((a, b) => a.seq - b.seq)
}
