import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Building2, Plus } from 'lucide-react'
import { useEntities } from '@/hooks/use-entities'
import LoadError from '@/components/LoadError'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from '@/lib/toast'
import { maskTaxId } from '@/lib/mask'
import {
  FORM_TYPE_OPTIONS, FORM_TYPE_LABEL, FORM_TYPE_COLOR,
  LEGAL_FORMS, LEGAL_FORM_LABEL,
} from '@/lib/labels'

export default function Entities() {
  const { entities, loading, error, reload, create } = useEntities()
  const nav = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const showNew = searchParams.get('new') === '1'
  const [name, setName] = useState('')
  const [formType, setFormType] = useState('1040')
  const [legalForm, setLegalForm] = useState('')
  const [ein, setEin] = useState('')
  const [creating, setCreating] = useState(false)

  const openNew = () => setSearchParams({ new: '1' })
  const closeNew = () => { setSearchParams({}); setName(''); setEin('') }

  const handleCreate = async () => {
    if (!name.trim()) return
    setCreating(true)
    try {
      const entity = await create({ name: name.trim(), form_type: formType, ein: ein || undefined, legal_form: legalForm || undefined })
      toast.success(`Created ${name}`)
      closeNew()
      if (entity?.id) nav(`/app/entities/${entity.id}`)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to create entity')
    }
    setCreating(false)
  }

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Entities</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your tax entities — individuals, C-Corps, and S-Corps.
          </p>
        </div>
        <Button onClick={openNew} className="gap-2 w-full sm:w-auto">
          <Plus className="h-4 w-4" />
          New Entity
        </Button>
      </div>

      {/* A failed load must never look like "No entities yet" — this page is
          the front door, and an outage that renders as an empty account is
          the exact bug the e2e error-visibility suite hunts. */}
      {error && !loading ? (
        <LoadError message={`Couldn't load your entities: ${error}`} onRetry={reload} />
      ) : loading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-5">
                <Skeleton className="h-5 w-2/3 mb-3" />
                <Skeleton className="h-4 w-1/3 mb-2" />
                <Skeleton className="h-3 w-1/2" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : entities.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Building2 className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-medium mb-1">No entities yet</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Create your first tax entity to get started with returns, scenarios, and QuickBooks.
            </p>
            <Button onClick={openNew} className="gap-2">
              <Plus className="h-4 w-4" />
              Create Entity
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {entities.map(entity => (
            <Card
              key={entity.id}
              className="cursor-pointer hover:border-primary/30 transition-colors"
              onClick={() => nav(`/app/entities/${entity.id}`)}
            >
              <CardContent className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                      <Building2 className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-medium leading-none">{entity.name}</h3>
                      {entity.ein && (
                        <p className="text-xs text-muted-foreground mt-1 font-mono">{maskTaxId(entity.ein)}</p>
                      )}
                    </div>
                  </div>
                  {entity.legal_form && (
                    <Badge variant="outline" className="bg-muted text-muted-foreground">
                      {LEGAL_FORM_LABEL[entity.legal_form] || entity.legal_form}
                    </Badge>
                  )}
                  <Badge variant="outline" className={FORM_TYPE_COLOR[entity.form_type] || ''}>
                    {FORM_TYPE_LABEL[entity.form_type] || entity.form_type}
                  </Badge>
                </div>
                <div className="flex gap-4 text-xs text-muted-foreground">
                  {entity.return_count !== undefined && (
                    <span>{entity.return_count} return{entity.return_count !== 1 ? 's' : ''}</span>
                  )}
                  {entity.scenario_count !== undefined && (
                    <span>{entity.scenario_count} scenario{entity.scenario_count !== 1 ? 's' : ''}</span>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={showNew} onOpenChange={open => { if (!open) closeNew() }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Entity</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="e.g. John Smith or Acme Corp"
                value={name}
                onChange={e => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="form_type">Tax treatment</Label>
              <Select value={formType} onValueChange={(v) => v && setFormType(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FORM_TYPE_OPTIONS.map(ft => (
                    <SelectItem key={ft.value} value={ft.value}>{ft.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Which return this entity files. This drives every calculation and deadline.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="legal_form">Legal form (optional)</Label>
              <Select value={legalForm || '__none__'} onValueChange={(v) => setLegalForm(v && v !== '__none__' ? v : '')}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEGAL_FORMS.map(lf => (
                    <SelectItem key={lf.value || '__none__'} value={lf.value || '__none__'}>{lf.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                What the entity legally is. An LLC that elected S-corp treatment on Form 2553
                is an LLC filing an 1120-S.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ein">EIN / SSN (optional)</Label>
              <Input
                id="ein"
                placeholder="XX-XXXXXXX"
                value={ein}
                onChange={e => setEin(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeNew}>Cancel</Button>
            <Button onClick={handleCreate} disabled={creating || !name.trim()}>
              {creating ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
