/**
 * The schema-driven "Compute Tax Return" dialog, extracted from ReturnsTab.
 * Owns its own form/year/inputs state; the parent only controls `open` and
 * receives onComputed. Compute.tsx and Extensions.tsx carry sibling
 * variants of this schema-driven form — unifying the trio on one
 * <SchemaForm> is a roadmap item.
 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import SchemaFieldInput from '@/components/SchemaFieldInput'
import { useSchema } from '@/hooks/use-schema'
import { toast } from '@/lib/toast'
import { coerceNumericInputs } from '@/lib/format'
import { COMPUTABLE_FORM_OPTIONS } from '@/lib/labels'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  entityId: string
  defaultFormType: string
  compute: (body: {
    entity_id: string; tax_year: number; form_type: string
    inputs: Record<string, unknown>
  }) => Promise<unknown>
  validate: (body: {
    form_type: string; tax_year: number; inputs: Record<string, unknown>
  }) => Promise<{ valid?: boolean; errors?: string[]; warnings?: string[] }>
  onComputed: () => void
}

export default function ComputeDialog({ open, onOpenChange, entityId, defaultFormType, compute, validate, onComputed }: Props) {
  const [formType, setFormType] = useState(defaultFormType || '1040')
  const [taxYear, setTaxYear] = useState(2024)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [computing, setComputing] = useState(false)
  const { schema, loading: schemaLoading } = useSchema(open ? formType : undefined, open ? taxYear : undefined)

  const updateInput = (key: string, value: string) => {
    setInputs(prev => ({ ...prev, [key]: value }))
  }

  // tax_year is a real schema field (MCP callers pass it in inputs), but
  // this form already has an authoritative Tax Year dropdown — rendering
  // the field too let a typed year silently override the dropdown (inputs
  // spread after tax_year in handleCompute). SOP-04 tester finding.
  const sections = schema?.fields?.filter(f => f.key !== 'tax_year').reduce((acc, field) => {
    const section = field.section || 'General'
    if (!acc[section]) acc[section] = []
    acc[section].push(field)
    return acc
  }, {} as Record<string, typeof schema.fields>) || {}

  const handleCompute = async () => {
    setComputing(true)
    try {
      const numericInputs = { tax_year: taxYear, ...coerceNumericInputs(inputs) }

      const valResult = await validate({ form_type: formType, tax_year: taxYear, inputs: numericInputs })
      if (valResult.errors && valResult.errors.length > 0) {
        toast.error(valResult.errors.join(', '))
        setComputing(false)
        return
      }
      valResult.warnings?.forEach(w => toast.warning(w))

      await compute({ entity_id: entityId, tax_year: taxYear, form_type: formType, inputs: numericInputs })
      toast.success('Return computed successfully')
      onOpenChange(false)
      setInputs({})
      onComputed()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Computation failed')
    }
    setComputing(false)
  }

  return (
<Dialog open={open} onOpenChange={onOpenChange}>
  <DialogContent className="w-[95vw] max-w-2xl max-h-[80vh] overflow-y-auto">
    <DialogHeader>
      <DialogTitle>Compute Tax Return</DialogTitle>
    </DialogHeader>
    <div className="space-y-4 py-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Form Type</Label>
          <Select value={formType} onValueChange={(v) => v && setFormType(v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {COMPUTABLE_FORM_OPTIONS.map(f => (
                <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Tax Year</Label>
          <Select value={String(taxYear)} onValueChange={v => setTaxYear(Number(v))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {[2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018].map(y => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {schemaLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
        </div>
      ) : schema?.fields ? (
        Object.entries(sections).map(([section, fields]) => (
          <div key={section}>
            <h4 className="text-sm font-medium text-muted-foreground mb-2 uppercase tracking-wide">{section}</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {fields.map(field => (
                <SchemaFieldInput
                  key={field.key}
                  field={field}
                  value={inputs[field.key] || ''}
                  onChange={v => updateInput(field.key, v)}
                />
              ))}
            </div>
          </div>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">
          No schema available for this form/year. You can enter fields manually.
        </p>
      )}
    </div>
    <DialogFooter>
      <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
      <Button onClick={handleCompute} disabled={computing}>
        {computing ? 'Computing...' : 'Compute'}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
  )
}
