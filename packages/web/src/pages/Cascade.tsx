import { useState } from 'react'
import { GitBranch, ArrowRight, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { toast } from 'sonner'

function fmt(n: unknown): string {
  if (typeof n !== 'number') return String(n ?? '')
  return n < 0 ? `-$${Math.abs(n).toLocaleString()}` : `$${n.toLocaleString()}`
}

const S_CORP_FIELDS = [
  { key: 'gross_receipts', label: 'Gross Receipts' },
  { key: 'cost_of_goods_sold', label: 'COGS' },
  { key: 'officer_compensation', label: 'Officer Compensation' },
  { key: 'salaries_wages', label: 'Salaries & Wages' },
  { key: 'taxes_licenses', label: 'Taxes & Licenses' },
  { key: 'other_deductions', label: 'Other Deductions' },
  { key: 'tax_year', label: 'Tax Year' },
]

const INDIVIDUAL_FIELDS = [
  { key: 'wages', label: 'W-2 Wages' },
  { key: 'interest_income', label: 'Interest Income' },
  { key: 'dividend_income', label: 'Dividend Income' },
  { key: 'other_income', label: 'Other Income' },
  { key: 'filing_status', label: 'Filing Status (single/mfj/mfs/hoh)' },
  { key: 'tax_year', label: 'Tax Year' },
]

export default function Cascade() {
  const [sCorpInputs, setSCorpInputs] = useState<Record<string, string>>({
    tax_year: '2024',
    gross_receipts: '500000',
    officer_compensation: '100000',
    salaries_wages: '50000',
  })
  const [individualInputs, setIndividualInputs] = useState<Record<string, string>>({
    tax_year: '2024',
    filing_status: 'mfj',
    wages: '100000',
  })
  const [result, setResult] = useState<Record<string, unknown> | null>(null)
  const [computing, setComputing] = useState(false)

  const handleCompute = async () => {
    setComputing(true)
    setResult(null)
    try {
      const sCorpParsed: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(sCorpInputs)) {
        const num = Number(v)
        sCorpParsed[k] = isNaN(num) ? v : num
      }
      const indParsed: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(individualInputs)) {
        const num = Number(v)
        indParsed[k] = isNaN(num) ? v : num
      }

      const data = await api('/api/compute/cascade', {
        method: 'POST',
        body: JSON.stringify({
          s_corp_inputs: sCorpParsed,
          individual_base: indParsed,
        }),
      })
      setResult(data)
      toast.success('Cascade computed')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Cascade failed')
    }
    setComputing(false)
  }

  const resultData = result as any

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Cascade Computation</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Compute S-Corp (1120-S) → K-1 → Individual (1040) in one step. See combined tax impact and QBI savings.
        </p>
      </div>

      {/* Flow diagram */}
      <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3 mb-6 text-xs sm:text-sm">
        <div className="px-2 sm:px-3 py-1.5 rounded-lg bg-purple-500/10 text-purple-400 border border-purple-500/20">
          S-Corp
        </div>
        <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="px-2 sm:px-3 py-1.5 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20">
          K-1
        </div>
        <ArrowRight className="h-4 w-4 text-muted-foreground" />
        <div className="px-3 py-1.5 rounded-lg bg-green-500/10 text-green-400 border border-green-500/20">
          Individual (1040)
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* S-Corp inputs */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-purple-400" />
              S-Corp Inputs
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {S_CORP_FIELDS.map(f => (
              <div key={f.key} className="space-y-1">
                <Label className="text-xs">{f.label}</Label>
                <Input
                  type={f.key === 'filing_status' ? 'text' : 'number'}
                  value={sCorpInputs[f.key] || ''}
                  onChange={e => setSCorpInputs(prev => ({ ...prev, [f.key]: e.target.value }))}
                  className="h-8 text-sm"
                />
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Individual inputs */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-400" />
              Individual Base Inputs
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {INDIVIDUAL_FIELDS.map(f => (
              <div key={f.key} className="space-y-1">
                <Label className="text-xs">{f.label}</Label>
                <Input
                  type={f.key === 'filing_status' ? 'text' : 'number'}
                  value={individualInputs[f.key] || ''}
                  onChange={e => setIndividualInputs(prev => ({ ...prev, [f.key]: e.target.value }))}
                  className="h-8 text-sm"
                />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Button onClick={handleCompute} disabled={computing} className="w-full mt-4 gap-2">
        {computing ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitBranch className="h-4 w-4" />}
        {computing ? 'Computing Cascade...' : 'Compute Cascade'}
      </Button>

      {/* Results */}
      {resultData && (
        <div className="mt-6 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
            {resultData.s_corp && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-purple-400">S-Corp Result</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-sm">
                  {Object.entries(resultData.s_corp as Record<string, unknown>)
                    .filter(([, v]) => typeof v === 'number')
                    .slice(0, 8)
                    .map(([k, v]) => (
                      <div key={k} className="flex justify-between">
                        <span className="text-muted-foreground text-xs capitalize">{k.replace(/_/g, ' ')}</span>
                        <span className="font-mono text-xs">{fmt(v)}</span>
                      </div>
                    ))}
                </CardContent>
              </Card>
            )}

            {resultData.k1 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-blue-400">K-1 Pass-Through</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-sm">
                  {Object.entries(resultData.k1 as Record<string, unknown>)
                    .filter(([, v]) => typeof v === 'number')
                    .slice(0, 8)
                    .map(([k, v]) => (
                      <div key={k} className="flex justify-between">
                        <span className="text-muted-foreground text-xs capitalize">{k.replace(/_/g, ' ')}</span>
                        <span className="font-mono text-xs">{fmt(v)}</span>
                      </div>
                    ))}
                </CardContent>
              </Card>
            )}

            {resultData.individual && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-green-400">Individual Result</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-sm">
                  {Object.entries(resultData.individual as Record<string, unknown>)
                    .filter(([, v]) => typeof v === 'number')
                    .slice(0, 8)
                    .map(([k, v]) => (
                      <div key={k} className="flex justify-between">
                        <span className="text-muted-foreground text-xs capitalize">{k.replace(/_/g, ' ')}</span>
                        <span className="font-mono text-xs">{fmt(v)}</span>
                      </div>
                    ))}
                </CardContent>
              </Card>
            )}
          </div>

          {(resultData.combined_tax !== undefined || resultData.qbi_savings !== undefined) && (
            <Card className="bg-primary/5 border-primary/20">
              <CardContent className="flex items-center justify-around py-4">
                {resultData.combined_tax !== undefined && (
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">Combined Tax</p>
                    <p className="text-2xl font-bold font-mono">{fmt(resultData.combined_tax)}</p>
                  </div>
                )}
                {resultData.qbi_savings !== undefined && (
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">QBI Savings</p>
                    <p className="text-2xl font-bold font-mono text-green-400">{fmt(resultData.qbi_savings)}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}
