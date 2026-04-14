import { useState } from 'react'
import { Clock, Loader2, Download, CheckCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { toast } from 'sonner'

function fmt(n: unknown): string {
  if (typeof n !== 'number') return String(n ?? '')
  return n < 0 ? `-$${Math.abs(n).toLocaleString()}` : `$${n.toLocaleString()}`
}

const EXTENSION_TYPES = [
  { value: '4868', label: 'Form 4868 — Individual Extension', desc: 'Automatic 6-month extension for individuals' },
  { value: '7004', label: 'Form 7004 — Business Extension', desc: 'Extension for partnerships, corporations, and trusts' },
  { value: '8868', label: 'Form 8868 — Exempt Org Extension', desc: 'Extension for tax-exempt organizations' },
]

const FIELD_MAP: Record<string, { key: string; label: string }[]> = {
  '4868': [
    { key: 'first_name', label: 'First Name' },
    { key: 'last_name', label: 'Last Name' },
    { key: 'ssn', label: 'SSN' },
    { key: 'address', label: 'Address' },
    { key: 'city', label: 'City' },
    { key: 'state', label: 'State' },
    { key: 'zip', label: 'ZIP' },
    { key: 'estimated_tax_liability', label: 'Estimated Tax Liability' },
    { key: 'total_payments', label: 'Total Payments Made' },
    { key: 'balance_due', label: 'Balance Due' },
  ],
  '7004': [
    { key: 'name', label: 'Business Name' },
    { key: 'ein', label: 'EIN' },
    { key: 'address', label: 'Address' },
    { key: 'city', label: 'City' },
    { key: 'state', label: 'State' },
    { key: 'zip', label: 'ZIP' },
    { key: 'form_code', label: 'Form Code (e.g. 12 for 1120)' },
    { key: 'tentative_tax', label: 'Tentative Total Tax' },
    { key: 'total_payments', label: 'Total Payments' },
    { key: 'balance_due', label: 'Balance Due' },
  ],
  '8868': [
    { key: 'name', label: 'Organization Name' },
    { key: 'ein', label: 'EIN' },
    { key: 'address', label: 'Address' },
    { key: 'city', label: 'City' },
    { key: 'state', label: 'State' },
    { key: 'zip', label: 'ZIP' },
    { key: 'form_filed', label: 'Form Being Filed (e.g. 990)' },
    { key: 'tentative_tax', label: 'Tentative Tax' },
    { key: 'total_payments', label: 'Total Payments' },
    { key: 'balance_due', label: 'Balance Due' },
  ],
}

export default function Extensions() {
  const [extType, setExtType] = useState('4868')
  const [taxYear, setTaxYear] = useState(2024)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [result, setResult] = useState<Record<string, unknown> | null>(null)
  const [filing, setFiling] = useState(false)
  const [validating, setValidating] = useState(false)
  const [errors, setErrors] = useState<string[]>([])

  const handleValidate = async () => {
    setValidating(true)
    setErrors([])
    try {
      const parsedInputs: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(inputs)) {
        const num = Number(v)
        parsedInputs[k] = isNaN(num) ? v : num
      }
      const data = await api<{ valid: boolean; errors?: string[] }>('/api/returns/extension/validate', {
        method: 'POST',
        body: JSON.stringify({ extension_type: extType, inputs: parsedInputs }),
      })
      if (data.valid) {
        toast.success('Validation passed')
      } else {
        setErrors(data.errors || ['Validation failed'])
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Validation failed')
    }
    setValidating(false)
  }

  const handleFile = async () => {
    setFiling(true)
    setErrors([])
    try {
      const parsedInputs: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(inputs)) {
        const num = Number(v)
        parsedInputs[k] = isNaN(num) ? v : num
      }
      const data = await api<Record<string, unknown>>('/api/returns/extension', {
        method: 'POST',
        body: JSON.stringify({
          extension_type: extType,
          tax_year: taxYear,
          inputs: parsedInputs,
          generate_pdf: true,
        }),
      })
      setResult(data)
      toast.success('Extension filed successfully')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Filing failed')
    }
    setFiling(false)
  }

  const fields = FIELD_MAP[extType] || []
  const pdfUrl = (result as any)?.pdf_url

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Tax Extensions</h1>
        <p className="text-sm text-muted-foreground mt-1">
          File Form 4868 (individual), 7004 (business), or 8868 (exempt org) extensions.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Extension Type</Label>
              <Select value={extType} onValueChange={v => { setExtType(v); setInputs({}); setResult(null); setErrors([]) }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {EXTENSION_TYPES.map(et => (
                    <SelectItem key={et.value} value={et.value}>{et.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Tax Year</Label>
              <Select value={String(taxYear)} onValueChange={v => setTaxYear(Number(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[2025, 2024, 2023, 2022].map(y => (
                    <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {EXTENSION_TYPES.find(et => et.value === extType)?.desc}
          </p>

          {errors.length > 0 && (
            <Alert variant="destructive">
              <AlertDescription>
                {errors.map((err, i) => <p key={i}>{err}</p>)}
              </AlertDescription>
            </Alert>
          )}

          <Card>
            <CardContent className="space-y-3 pt-4">
              {fields.map(f => (
                <div key={f.key} className="space-y-1">
                  <Label className="text-xs">{f.label}</Label>
                  <Input
                    value={inputs[f.key] || ''}
                    onChange={e => setInputs(prev => ({ ...prev, [f.key]: e.target.value }))}
                    className="h-8 text-sm"
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="flex gap-2">
            <Button variant="outline" onClick={handleValidate} disabled={validating} className="gap-2">
              {validating ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
              Validate
            </Button>
            <Button onClick={handleFile} disabled={filing} className="gap-2 flex-1">
              {filing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4" />}
              {filing ? 'Filing...' : 'File Extension'}
            </Button>
          </div>
        </div>

        {/* Result */}
        <div>
          {result ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-green-400" />
                  Extension Filed
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1 text-sm">
                  {Object.entries(result)
                    .filter(([k, v]) => typeof v === 'number' || (typeof v === 'string' && k !== 'pdf_url'))
                    .map(([k, v]) => (
                      <div key={k} className="flex justify-between py-1">
                        <span className="text-muted-foreground capitalize">{k.replace(/_/g, ' ')}</span>
                        <span className="font-mono">{typeof v === 'number' ? fmt(v) : String(v)}</span>
                      </div>
                    ))}
                </div>
                {pdfUrl && (
                  <Button variant="outline" className="w-full gap-2" onClick={() => window.open(pdfUrl, '_blank')}>
                    <Download className="h-4 w-4" />
                    Download PDF
                  </Button>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                <Clock className="h-10 w-10 text-muted-foreground/50 mb-3" />
                <p className="text-sm text-muted-foreground">
                  Fill in the extension form and click File to generate.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
