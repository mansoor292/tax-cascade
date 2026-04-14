import { useState, useEffect } from 'react'
import {
  Link2,
  RefreshCw,
  DollarSign,
  TrendingUp,
  Building,
  CheckCircle,
} from 'lucide-react'
import { type Entity } from '@/hooks/use-entities'
import { useQbo, type Transaction, type Account } from '@/hooks/use-qbo'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from 'sonner'

function fmt(n: unknown): string {
  if (typeof n !== 'number') return String(n ?? '')
  return n < 0 ? `-$${Math.abs(n).toLocaleString()}` : `$${n.toLocaleString()}`
}

interface Props {
  entityId: string
  entity: Entity
}

export default function QuickBooksTab({ entityId, entity }: Props) {
  const { status, loading, connect, getFinancials, getTransactions, getAccounts, getMapping } = useQbo(entityId)
  const [year, setYear] = useState(2024)
  const [financials, setFinancials] = useState<Record<string, unknown> | null>(null)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [mapping, setMapping] = useState<Record<string, unknown> | null>(null)
  const [loadingData, setLoadingData] = useState(false)
  const [txFilter, setTxFilter] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const loadData = async (refresh = false) => {
    setLoadingData(true)
    try {
      const [fin, tx, accts] = await Promise.all([
        getFinancials(year, refresh),
        getTransactions({ year }),
        getAccounts(),
      ])
      if (fin) setFinancials(fin as Record<string, unknown>)
      setTransactions(tx)
      setAccounts(accts)
    } catch {
      // Individual calls may fail
    }
    setLoadingData(false)
  }

  const loadMapping = async () => {
    try {
      const data = await getMapping(entity.form_type)
      setMapping(data)
    } catch {
      // Mapping may not exist
    }
  }

  useEffect(() => {
    if (status.connected) {
      loadData()
      loadMapping()
    }
  }, [status.connected, year])

  const handleRefresh = async () => {
    setRefreshing(true)
    await loadData(true)
    setRefreshing(false)
    toast.success('Data refreshed from QuickBooks')
  }

  const handleConnect = async () => {
    try {
      await connect()
      toast.info('QuickBooks auth window opened')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Connection failed')
    }
  }

  if (loading) {
    return <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
  }

  if (!status.connected) {
    return (
      <div className="space-y-4">
        <h3 className="text-lg font-medium">QuickBooks</h3>
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Building className="h-10 w-10 text-muted-foreground/50 mb-3" />
            <h4 className="font-medium mb-1">Not Connected</h4>
            <p className="text-sm text-muted-foreground mb-4">
              Connect QuickBooks to pull financials, transactions, and auto-map to tax forms.
            </p>
            <Button onClick={handleConnect} className="gap-2">
              <Link2 className="h-4 w-4" />
              Connect QuickBooks
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const pl = financials?.profit_and_loss as Record<string, unknown> | undefined
  const bs = financials?.balance_sheet as Record<string, unknown> | undefined

  const filteredTx = txFilter
    ? transactions.filter(t =>
        t.name?.toLowerCase().includes(txFilter.toLowerCase()) ||
        t.account?.toLowerCase().includes(txFilter.toLowerCase()) ||
        t.memo?.toLowerCase().includes(txFilter.toLowerCase())
      )
    : transactions

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-lg font-medium">QuickBooks</h3>
          <Badge variant="outline" className="gap-1 text-green-400 border-green-500/20">
            <CheckCircle className="h-3 w-3" />
            Connected
          </Badge>
          {status.company_name && (
            <span className="text-sm text-muted-foreground">{status.company_name}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
            <SelectTrigger className="w-24 h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[2025, 2024, 2023, 2022, 2021].map(y => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing} className="gap-1">
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      <Tabs defaultValue="financials">
        <TabsList>
          <TabsTrigger value="financials">Financials</TabsTrigger>
          <TabsTrigger value="transactions">
            Transactions{transactions.length > 0 && ` (${transactions.length})`}
          </TabsTrigger>
          <TabsTrigger value="accounts">Accounts</TabsTrigger>
          {mapping && <TabsTrigger value="mapping">Tax Mapping</TabsTrigger>}
        </TabsList>

        <TabsContent value="financials" className="space-y-4">
          {loadingData ? (
            <div className="grid gap-4 md:grid-cols-2">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-40" />)}</div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {/* P&L Card */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-primary" />
                    Profit & Loss
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {pl ? (
                    <div className="space-y-2 text-sm">
                      {Object.entries(pl)
                        .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
                        .slice(0, 10)
                        .map(([k, v]) => (
                          <div key={k} className="flex justify-between">
                            <span className="text-muted-foreground capitalize">{k.replace(/_/g, ' ')}</span>
                            <span className="font-mono">{typeof v === 'number' ? fmt(v) : String(v)}</span>
                          </div>
                        ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No P&L data available</p>
                  )}
                </CardContent>
              </Card>

              {/* Balance Sheet Card */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <DollarSign className="h-4 w-4 text-primary" />
                    Balance Sheet
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {bs ? (
                    <div className="space-y-2 text-sm">
                      {Object.entries(bs)
                        .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
                        .slice(0, 10)
                        .map(([k, v]) => (
                          <div key={k} className="flex justify-between">
                            <span className="text-muted-foreground capitalize">{k.replace(/_/g, ' ')}</span>
                            <span className="font-mono">{typeof v === 'number' ? fmt(v) : String(v)}</span>
                          </div>
                        ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No balance sheet data available</p>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>

        <TabsContent value="transactions" className="space-y-3">
          <Input
            placeholder="Filter by name, account, or memo..."
            value={txFilter}
            onChange={e => setTxFilter(e.target.value)}
            className="max-w-sm h-8"
          />
          {loadingData ? (
            <Skeleton className="h-40" />
          ) : filteredTx.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No transactions found.</p>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTx.slice(0, 100).map((tx, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-xs">{tx.date}</TableCell>
                      <TableCell><Badge variant="outline" className="text-xs">{tx.type}</Badge></TableCell>
                      <TableCell className="text-sm">{tx.name}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{tx.account}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmt(tx.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {filteredTx.length > 100 && (
                <div className="p-3 text-center text-xs text-muted-foreground">
                  Showing 100 of {filteredTx.length} transactions
                </div>
              )}
            </Card>
          )}
        </TabsContent>

        <TabsContent value="accounts" className="space-y-3">
          {loadingData ? (
            <Skeleton className="h-40" />
          ) : accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No accounts found.</p>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accounts.map((acct, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-medium text-sm">{acct.name}</TableCell>
                      <TableCell><Badge variant="outline" className="text-xs">{acct.type}</Badge></TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmt(acct.balance)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>

        {mapping && (
          <TabsContent value="mapping" className="space-y-3">
            <p className="text-sm text-muted-foreground">
              How QuickBooks P&L categories map to {entity.form_type} tax form fields.
            </p>
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>QBO Category</TableHead>
                    <TableHead>Tax Form Field</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Object.entries(mapping as Record<string, string>).map(([qbo, field]) => (
                    <TableRow key={qbo}>
                      <TableCell className="text-sm">{qbo}</TableCell>
                      <TableCell className="text-sm font-mono text-muted-foreground">{String(field)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
