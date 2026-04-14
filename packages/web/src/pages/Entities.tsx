import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Building2, Plus } from 'lucide-react'
import { useEntities } from '@/hooks/use-entities'
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
import { toast } from 'sonner'

const FORM_TYPES = [
  { value: '1040', label: 'Individual (1040)' },
  { value: '1120', label: 'C-Corporation (1120)' },
  { value: '1120S', label: 'S-Corporation (1120-S)' },
]

const FORM_TYPE_LABEL: Record<string, string> = {
  '1040': 'Individual',
  '1120': 'C-Corp',
  '1120S': 'S-Corp',
  '1120-S': 'S-Corp',
}

const FORM_TYPE_COLOR: Record<string, string> = {
  '1040': 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  '1120': 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  '1120S': 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  '1120-S': 'bg-purple-500/10 text-purple-400 border-purple-500/20',
}

export default function Entities() {
  const { entities, loading, create } = useEntities()
  const nav = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const showNew = searchParams.get('new') === '1'
  const [name, setName] = useState('')
  const [formType, setFormType] = useState('1040')
  const [ein, setEin] = useState('')
  const [creating, setCreating] = useState(false)

  const openNew = () => setSearchParams({ new: '1' })
  const closeNew = () => { setSearchParams({}); setName(''); setEin('') }

  const handleCreate = async () => {
    if (!name.trim()) return
    setCreating(true)
    try {
      const entity = await create({ name: name.trim(), form_type: formType, ein: ein || undefined })
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
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Entities</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your tax entities — individuals, C-Corps, and S-Corps.
          </p>
        </div>
        <Button onClick={openNew} className="gap-2">
          <Plus className="h-4 w-4" />
          New Entity
        </Button>
      </div>

      {loading ? (
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
                        <p className="text-xs text-muted-foreground mt-1 font-mono">{entity.ein}</p>
                      )}
                    </div>
                  </div>
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
              <Label htmlFor="form_type">Entity Type</Label>
              <Select value={formType} onValueChange={setFormType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FORM_TYPES.map(ft => (
                    <SelectItem key={ft.value} value={ft.value}>{ft.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
