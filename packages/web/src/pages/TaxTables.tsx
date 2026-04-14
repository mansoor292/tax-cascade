import { useState } from 'react'
import { TableProperties } from 'lucide-react'
import { useTaxTables } from '@/hooks/use-schema'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'

function fmt(n: unknown): string {
  if (typeof n !== 'number') return String(n ?? '')
  return n < 0 ? `-$${Math.abs(n).toLocaleString()}` : `$${n.toLocaleString()}`
}

export default function TaxTables() {
  const [year, setYear] = useState(2024)
  const { tables, loading } = useTaxTables(year)

  const brackets = (tables?.brackets || tables?.tax_brackets) as Record<string, unknown> | unknown[] | undefined
  const standardDeduction = tables?.standard_deduction as Record<string, unknown> | number | undefined
  const rates = (tables?.rates || tables?.corporate_rate) as number | Record<string, unknown> | undefined

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tax Tables</h1>
          <p className="text-sm text-muted-foreground mt-1">
            IRS tax brackets, standard deductions, and rate tables by year.
          </p>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Year</Label>
          <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018].map(y => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {loading ? (
        <div className="space-y-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40" />)}</div>
      ) : !tables ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <TableProperties className="h-10 w-10 text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground">No tax table data available for {year}.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* Standard Deduction */}
          {standardDeduction && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Standard Deduction — {year}</CardTitle>
              </CardHeader>
              <CardContent>
                {typeof standardDeduction === 'object' ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                    {Object.entries(standardDeduction as Record<string, unknown>).map(([status, amount]) => (
                      <div key={status} className="text-center p-3 rounded-lg bg-muted/30">
                        <p className="text-xs text-muted-foreground uppercase tracking-wide capitalize">
                          {status.replace(/_/g, ' ')}
                        </p>
                        <p className="text-lg font-bold font-mono mt-1">{fmt(amount)}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-lg font-mono">{fmt(standardDeduction)}</p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Tax Brackets */}
          {brackets && typeof brackets === 'object' && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Tax Brackets — {year}</CardTitle>
              </CardHeader>
              <CardContent>
                {Array.isArray(brackets) ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Rate</TableHead>
                        <TableHead>From</TableHead>
                        <TableHead>To</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {brackets.map((b: any, i: number) => (
                        <TableRow key={i}>
                          <TableCell className="font-medium">{b.rate ? `${(b.rate * 100).toFixed(0)}%` : b.pct ?? ''}</TableCell>
                          <TableCell className="font-mono">{fmt(b.min ?? b.from ?? b.lower)}</TableCell>
                          <TableCell className="font-mono">{b.max ?? b.to ?? b.upper ? fmt(b.max ?? b.to ?? b.upper) : 'No limit'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  Object.entries(brackets as Record<string, unknown>).map(([status, statusBrackets]) => (
                    <div key={status} className="mb-4">
                      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2 capitalize">
                        {status.replace(/_/g, ' ')}
                      </h4>
                      {Array.isArray(statusBrackets) && (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Rate</TableHead>
                              <TableHead>From</TableHead>
                              <TableHead>To</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {statusBrackets.map((b: any, i: number) => (
                              <TableRow key={i}>
                                <TableCell className="font-medium">{b.rate ? `${(b.rate * 100).toFixed(0)}%` : b.pct ?? ''}</TableCell>
                                <TableCell className="font-mono">{fmt(b.min ?? b.from ?? b.lower)}</TableCell>
                                <TableCell className="font-mono">{b.max ?? b.to ?? b.upper ? fmt(b.max ?? b.to ?? b.upper) : 'No limit'}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          )}

          {/* Corporate Rate */}
          {rates !== undefined && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Corporate Tax Rate — {year}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold font-mono">
                  {typeof rates === 'number' ? `${(rates * 100).toFixed(0)}%` : JSON.stringify(rates)}
                </p>
              </CardContent>
            </Card>
          )}

          {/* Raw data fallback */}
          {!brackets && !standardDeduction && !rates && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Tax Data — {year}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1 text-sm">
                  {Object.entries(tables).map(([k, v]) => (
                    <div key={k} className="flex justify-between py-1">
                      <span className="text-muted-foreground capitalize">{k.replace(/_/g, ' ')}</span>
                      <span className="font-mono">
                        {typeof v === 'number' ? fmt(v) : typeof v === 'string' ? v : JSON.stringify(v)}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}
