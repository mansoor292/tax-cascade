import { useState, useEffect } from 'react'
import {
  Link2,
  RefreshCw,
  DollarSign,
  TrendingUp,
  Building,
  CheckCircle,
  Maximize2,
  Loader2,
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'

function fmt(n: unknown): string {
  if (typeof n !== 'number') return String(n ?? '')
  return n < 0 ? `-$${Math.abs(n).toLocaleString()}` : `$${n.toLocaleString()}`
}

interface Props {
  entityId: string
  entity: Entity
}

interface DrilldownState {
  report: 'profit-and-loss' | 'balance-sheet' | 'trial-balance'
  title: string
}

export default function QuickBooksTab({ entityId, entity }: Props) {
  const { status, loading, connect, getFinancials, getReport, getTransactions, getAccounts, getMapping } = useQbo(entityId)
  const [year, setYear] = useState(2024)
  const [financials, setFinancials] = useState<Record<string, unknown> | null>(null)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [mapping, setMapping] = useState<Record<string, unknown> | null>(null)
  const [loadingData, setLoadingData] = useState(false)
  const [txFilter, setTxFilter] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [drilldown, setDrilldown] = useState<DrilldownState | null>(null)

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
          {status.accounting_method && (
            <Badge
              variant="outline"
              className={
                status.accounting_method.toLowerCase() === 'cash'
                  ? 'gap-1 text-blue-400 border-blue-500/20 bg-blue-500/5'
                  : 'gap-1 text-amber-400 border-amber-500/20 bg-amber-500/5'
              }
              title="QBO ReportBasis preference — all financials below are reported on this basis"
            >
              {status.accounting_method} basis
            </Badge>
          )}
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
            <>
            <div className="grid gap-4 md:grid-cols-2">
              {/* P&L Card */}
              <Card
                className="cursor-pointer hover:border-primary/40 hover:bg-accent/30 transition-colors"
                onClick={() => setDrilldown({ report: 'profit-and-loss', title: 'Profit & Loss' })}
                title="Click to view full profit & loss detail"
              >
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <TrendingUp className="h-4 w-4 text-primary" />
                      Profit & Loss
                    </span>
                    <Maximize2 className="h-3.5 w-3.5 text-muted-foreground/60" />
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
              <Card
                className="cursor-pointer hover:border-primary/40 hover:bg-accent/30 transition-colors"
                onClick={() => setDrilldown({ report: 'balance-sheet', title: 'Balance Sheet' })}
                title="Click to view full balance sheet detail"
              >
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <DollarSign className="h-4 w-4 text-primary" />
                      Balance Sheet
                    </span>
                    <Maximize2 className="h-3.5 w-3.5 text-muted-foreground/60" />
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDrilldown({ report: 'trial-balance', title: 'Trial Balance' })}
              className="gap-2"
            >
              <Maximize2 className="h-3.5 w-3.5" />
              Open Trial Balance
            </Button>
            </>
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

      {drilldown && (
        <ReportDrilldownDialog
          open={!!drilldown}
          onOpenChange={(open) => !open && setDrilldown(null)}
          title={drilldown.title}
          year={year}
          accountingMethod={status.accounting_method}
          fetch={() => getReport(drilldown.report, year)}
        />
      )}
    </div>
  )
}

// ─── Full-report drilldown dialog ───

interface ReportRow {
  label: string
  value: number | string
  depth?: number
  isTotal?: boolean
}

function flattenQboRows(rows: unknown[], depth = 0, out: ReportRow[] = []): ReportRow[] {
  if (!Array.isArray(rows)) return out
  for (const row of rows as Array<Record<string, any>>) {
    const colData = row.ColData as Array<{ value?: string }> | undefined
    const headerCol = row.Header?.ColData as Array<{ value?: string }> | undefined
    const summaryCol = row.Summary?.ColData as Array<{ value?: string }> | undefined
    const children = row.Rows?.Row as unknown[] | undefined

    if (row.type === 'Section') {
      const headerLabel = headerCol?.[0]?.value || row.group
      if (headerLabel) out.push({ label: String(headerLabel), value: '', depth, isTotal: false })
      if (children) flattenQboRows(children, depth + 1, out)
      if (summaryCol) {
        const label = summaryCol[0]?.value || `Total ${headerLabel || ''}`.trim()
        const val = parseFloat(summaryCol[1]?.value || '')
        out.push({ label: String(label), value: Number.isFinite(val) ? val : '', depth, isTotal: true })
      }
    } else if (row.type === 'Data' && colData) {
      const label = colData[0]?.value || ''
      const val = parseFloat(colData[1]?.value || '')
      out.push({ label: String(label), value: Number.isFinite(val) ? val : '', depth, isTotal: false })
    }
  }
  return out
}

function fmtReport(v: number | string): string {
  if (typeof v !== 'number') return String(v || '')
  return v < 0 ? `-$${Math.abs(v).toLocaleString()}` : `$${v.toLocaleString()}`
}

function ReportDrilldownDialog({
  open,
  onOpenChange,
  title,
  year,
  accountingMethod,
  fetch,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  year: number
  accountingMethod?: string | null
  fetch: () => Promise<unknown>
}) {
  const [rows, setRows] = useState<ReportRow[]>([])
  const [flat, setFlat] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null); setRows([]); setFlat({})
    fetch()
      .then((data: any) => {
        if (cancelled) return
        // Prefer the raw QBO tree so we can render nested section totals.
        const raw = data?.raw_data
        const rawRows = raw?.Rows?.Row as unknown[] | undefined
        if (rawRows) setRows(flattenQboRows(rawRows))
        const summary = (data?.summary || {}) as Record<string, number>
        setFlat(summary)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load report')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            {title} <span className="text-muted-foreground font-normal text-sm">· {year}</span>
            {accountingMethod && (
              <Badge variant="outline" className="text-xs">{accountingMethod} basis</Badge>
            )}
          </DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <p className="text-sm text-destructive py-4">{error}</p>
        ) : rows.length > 0 ? (
          <Table>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={i} className={r.isTotal ? 'font-semibold bg-muted/30' : ''}>
                  <TableCell
                    className="text-sm"
                    style={{ paddingLeft: `${(r.depth || 0) * 16 + 12}px` }}
                  >
                    {r.label}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {r.value === '' ? '' : fmtReport(r.value)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : Object.keys(flat).length > 0 ? (
          <Table>
            <TableBody>
              {Object.entries(flat).map(([k, v]) => (
                <TableRow key={k}>
                  <TableCell className="text-sm">{k}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{fmtReport(v)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground py-4">No data available.</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
