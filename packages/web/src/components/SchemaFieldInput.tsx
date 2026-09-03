/**
 * One schema-driven form field, shared by ComputeDialog and the Compute
 * page (Extensions still carries its own variant — no enum fields there
 * yet). Extracted after an SOP-04 tester met filing_status as a free-text
 * box hinting "0" and had to ask what to type: a field whose schema
 * declares `options` is a closed set and renders as a Select, and only
 * numeric fields may hint 0 — a string field with a numeric placeholder
 * reads as a number box.
 */
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { FieldDef } from '@/hooks/use-schema'

interface Props {
  field: FieldDef
  value: string
  onChange: (value: string) => void
}

export default function SchemaFieldInput({ field, value, onChange }: Props) {
  return (
    <div className="space-y-1" data-testid={`field-${field.key}`}>
      <Label className="text-xs">{field.label || field.key.replace(/_/g, ' ')}</Label>
      {field.options?.length ? (
        <Select value={value || ''} onValueChange={v => v && onChange(v)}>
          <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select…" /></SelectTrigger>
          <SelectContent>
            {field.options.map(o => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          type={field.type === 'number' ? 'number' : 'text'}
          placeholder={field.default !== undefined ? String(field.default) : field.type === 'number' ? '0' : ''}
          value={value}
          onChange={e => onChange(e.target.value)}
          className="h-8 text-sm"
        />
      )}
    </div>
  )
}
