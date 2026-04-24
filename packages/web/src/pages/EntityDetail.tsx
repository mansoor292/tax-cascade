import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Building2, Pencil, ArrowLeft } from 'lucide-react'
import { useEntity } from '@/hooks/use-entities'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

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
import { toast } from 'sonner'
import { api } from '@/lib/api'
import ReturnsTab from '@/components/tabs/ReturnsTab'
import ScenariosTab from '@/components/tabs/ScenariosTab'
import DocumentsTab from '@/components/tabs/DocumentsTab'
import QuickBooksTab from '@/components/tabs/QuickBooksTab'

const FORM_TYPE_LABEL: Record<string, string> = {
  '1040': 'Individual (1040)',
  '1120': 'C-Corp (1120)',
  '1120S': 'S-Corp (1120-S)',
  '1120-S': 'S-Corp (1120-S)',
}

type Basis = 'accrual' | 'cash' | ''

function readBasis(entity: { meta?: Record<string, unknown> } | null | undefined): Basis {
  const m = entity?.meta?.accounting_method
  if (typeof m === 'string') {
    const s = m.toLowerCase()
    if (s.startsWith('cash')) return 'cash'
    if (s.startsWith('accrual')) return 'accrual'
  }
  return ''
}

export default function EntityDetail() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const { entity, returns, scenarios, loading, reload } = useEntity(id)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editEin, setEditEin] = useState('')
  const [editFormType, setEditFormType] = useState('')
  const [editBasis, setEditBasis] = useState<Basis>('')
  const [saving, setSaving] = useState(false)

  const openEdit = () => {
    if (!entity) return
    setEditName(entity.name)
    setEditEin(entity.ein || '')
    setEditFormType(entity.form_type)
    setEditBasis(readBasis(entity))
    setEditing(true)
  }

  const handleSave = async () => {
    if (!id) return
    setSaving(true)
    try {
      await api(`/api/entities/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editName,
          ein: editEin || undefined,
          form_type: editFormType,
          // meta_merge preserves any other keys on entity.meta and only
          // overwrites accounting_method. Empty string clears the override
          // so the server falls back to QBO ReportPrefs.
          meta_merge: { accounting_method: editBasis || null },
        }),
      })
      toast.success('Entity updated')
      setEditing(false)
      reload()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to update')
    }
    setSaving(false)
  }

  const currentBasis = readBasis(entity)

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      </div>
    )
  }

  if (!entity) {
    return (
      <div className="text-center py-16">
        <p className="text-muted-foreground">Entity not found</p>
        <Button variant="link" onClick={() => nav('/app/entities')}>Back to entities</Button>
      </div>
    )
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" onClick={() => nav('/app/entities')} className="shrink-0">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Building2 className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight truncate">{entity.name}</h1>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <Badge variant="outline" className="text-xs">
                {FORM_TYPE_LABEL[entity.form_type] || entity.form_type}
              </Badge>
              {currentBasis && (
                <Badge
                  variant="outline"
                  className={`text-xs capitalize ${
                    currentBasis === 'cash'
                      ? 'text-blue-400 border-blue-500/20 bg-blue-500/5'
                      : 'text-amber-400 border-amber-500/20 bg-amber-500/5'
                  }`}
                  title={`${currentBasis} basis — used when recomputing from QBO. Click Edit to change.`}
                >
                  {currentBasis} basis
                </Badge>
              )}
              {entity.ein && (
                <span className="text-xs text-muted-foreground font-mono">{entity.ein}</span>
              )}
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={openEdit} className="gap-2 shrink-0">
          <Pencil className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Edit</span>
        </Button>
      </div>

      <Tabs defaultValue="returns" className="space-y-4">
        <TabsList>
          <TabsTrigger value="returns">
            Returns {returns.length > 0 && <Badge variant="secondary" className="ml-1.5 text-xs px-1.5">{returns.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="scenarios">
            Scenarios {scenarios.length > 0 && <Badge variant="secondary" className="ml-1.5 text-xs px-1.5">{scenarios.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="quickbooks">QuickBooks</TabsTrigger>
        </TabsList>

        <TabsContent value="returns">
          <ReturnsTab entityId={id!} entity={entity} onUpdate={reload} />
        </TabsContent>

        <TabsContent value="scenarios">
          <ScenariosTab entityId={id!} entity={entity} onUpdate={reload} />
        </TabsContent>

        <TabsContent value="documents">
          <DocumentsTab entityId={id!} />
        </TabsContent>

        <TabsContent value="quickbooks">
          <QuickBooksTab entityId={id!} entity={entity} />
        </TabsContent>
      </Tabs>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Entity</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={editName} onChange={e => setEditName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Entity Type</Label>
              <Select value={editFormType} onValueChange={(v) => v && setEditFormType(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1040">Individual (1040)</SelectItem>
                  <SelectItem value="1120">C-Corporation (1120)</SelectItem>
                  <SelectItem value="1120S">S-Corporation (1120-S)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>EIN / SSN</Label>
              <Input value={editEin} onChange={e => setEditEin(e.target.value)} placeholder="XX-XXXXXXX" />
            </div>
            <div className="space-y-2">
              <Label>Accounting basis</Label>
              <Select value={editBasis || '__qbo__'} onValueChange={v => setEditBasis(v === '__qbo__' ? '' : v as Basis)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__qbo__">Follow QBO company preference</SelectItem>
                  <SelectItem value="accrual">Accrual</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Overrides QBO's company-wide ReportBasis for this entity's financials and Recompute-from-QBO.
                Use Cash when a return was filed on a cash basis even if QBO is set to accrual.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
