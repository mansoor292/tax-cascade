import { useState, useEffect } from 'react'
import { Key, Plus, Trash2, Copy, Loader2, Eye, EyeOff } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'

interface ApiKey {
  id: string
  name: string
  key_value?: string
  is_active: boolean
  created_at: string
  last_used_at?: string
}

export default function Settings() {
  const { user } = useAuth()
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [keyName, setKeyName] = useState('')
  const [creating, setCreating] = useState(false)
  const [newKey, setNewKey] = useState<string | null>(null)
  const [showKey, setShowKey] = useState<string | null>(null)

  const loadKeys = async () => {
    setLoading(true)
    try {
      const data = await api<{ user: { api_keys?: ApiKey[] } }>('/auth/me')
      setKeys(data.user?.api_keys || [])
    } catch {
      setKeys([])
    }
    setLoading(false)
  }

  useEffect(() => { loadKeys() }, [])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const data = await api<{ api_key: ApiKey }>('/auth/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name: keyName }),
      })
      setNewKey(data.api_key?.key_value || null)
      toast.success('API key created')
      loadKeys()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to create key')
    }
    setCreating(false)
  }

  const handleRevoke = async (id: string) => {
    if (!confirm('Revoke this API key? This cannot be undone.')) return
    try {
      await api(`/auth/api-keys/${id}`, { method: 'DELETE' })
      toast.success('API key revoked')
      loadKeys()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to revoke key')
    }
  }

  const copyKey = (value: string) => {
    navigator.clipboard.writeText(value)
    toast.success('Copied to clipboard')
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your account and API keys.
        </p>
      </div>

      {/* Account info */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Account</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Email</span>
              <span>{user?.email}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">User ID</span>
              <span className="font-mono text-xs">{user?.id}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Separator className="my-6" />

      {/* API Keys */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-medium">API Keys</h2>
          <p className="text-sm text-muted-foreground">
            Use API keys for programmatic access to the REST API and MCP server.
          </p>
        </div>
        <Button onClick={() => { setShowCreate(true); setNewKey(null); setKeyName('') }} size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          Create Key
        </Button>
      </div>

      {loading ? (
        <Skeleton className="h-40" />
      ) : keys.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Key className="h-10 w-10 text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground mb-3">No API keys yet.</p>
            <Button onClick={() => setShowCreate(true)} size="sm" variant="outline" className="gap-2">
              <Plus className="h-4 w-4" />
              Create Key
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last Used</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map(key => (
                <TableRow key={key.id}>
                  <TableCell className="font-medium">{key.name}</TableCell>
                  <TableCell>
                    <Badge variant={key.is_active ? 'default' : 'secondary'}>
                      {key.is_active ? 'Active' : 'Revoked'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(key.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {key.last_used_at ? new Date(key.last_used_at).toLocaleDateString() : 'Never'}
                  </TableCell>
                  <TableCell className="text-right">
                    {key.is_active && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleRevoke(key.id)}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Create key dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{newKey ? 'API Key Created' : 'Create API Key'}</DialogTitle>
          </DialogHeader>
          {newKey ? (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">
                Copy this key now — it won't be shown again.
              </p>
              <div className="flex gap-2">
                <Input value={newKey} readOnly className="font-mono text-sm" />
                <Button variant="outline" size="icon" onClick={() => copyKey(newKey)}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label>Key Name</Label>
                <Input
                  value={keyName}
                  onChange={e => setKeyName(e.target.value)}
                  placeholder="e.g. Development, Claude MCP"
                  autoFocus
                />
              </div>
            </div>
          )}
          <DialogFooter>
            {newKey ? (
              <Button onClick={() => setShowCreate(false)}>Done</Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
                <Button onClick={handleCreate} disabled={creating || !keyName.trim()}>
                  {creating ? 'Creating...' : 'Create'}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
