/**
 * Whether the IRS has accepted a filed return: its transcript shows the
 * return processed in its own year (api review/filing.ts). Not accepted until
 * a transcript confirms it; "Misposted" when the IRS put it, or another
 * year's return, in the wrong period. The reason is in the title and in the
 * expanded year. An amendment's filing reads the same way, accepted by a
 * TC977 instead.
 */
import { Badge } from '@/components/ui/badge'
import type { YearFiling } from '@/lib/filing'

type Filing = Pick<YearFiling, 'filed' | 'accepted' | 'accepted_why' | 'holds_return_of' | 'posted_in'> | { filed: true; accepted: boolean; accepted_why: string; holds_return_of?: undefined; posted_in?: undefined }

export default function AcceptedBadge({ filing }: { filing: Filing }) {
  if (!filing.filed) return null
  if (filing.accepted) {
    return <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-400 border-emerald-500/30" title={filing.accepted_why}>Accepted</Badge>
  }
  const misposted = filing.holds_return_of !== undefined || filing.posted_in !== undefined
  return (
    <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-400 border-amber-500/30" title={filing.accepted_why}>
      {misposted ? 'Misposted' : 'Not accepted yet'}
    </Badge>
  )
}
