import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { ChevronDown } from 'lucide-react'

export default function Returns() {
  const [returns, setReturns] = useState<any[]>([])
  const [forms, setForms] = useState<any>(null)
  const [view, setView] = useState<'returns' | 'forms'>('returns')
  const [selected, setSelected] = useState<any>(null)

  useEffect(() => {
    api('/api/returns').then(d => setReturns(d.returns || [])).catch(() => {})
    api('/api/forms').then(setForms).catch(() => {})
  }, [])

  const fmt = (n: number) => n < 0 ? `(${Math.abs(n).toLocaleString()})` : `$${n.toLocaleString()}`

  // Group returns by entity
  const byEntity: Record<string, any[]> = {}
  for (const r of returns) {
    const name = r.tax_entity?.name || 'Unknown'
    if (!byEntity[name]) byEntity[name] = []
    byEntity[name].push(r)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Returns</h2>
        <div className="flex gap-1">
          {['returns', 'forms'].map(v => (
            <button key={v} onClick={() => setView(v as any)}
              className={`px-3 py-1.5 rounded text-sm ${view === v ? 'bg-zinc-800 text-white' : 'text-zinc-500'}`}>
              {v === 'returns' ? 'Tax Returns' : 'Form Library'}
            </button>
          ))}
        </div>
      </div>

      {view === 'returns' ? (
        !returns.length ? (
          <p className="text-zinc-600 text-sm py-8 text-center">No processed returns yet. Upload a tax return PDF to get started.</p>
        ) : (
          <div className="space-y-4">
            {Object.entries(byEntity).map(([entity, rets]) => (
              <div key={entity} className="bg-zinc-900 border border-zinc-800 rounded">
                <div className="px-4 py-3 border-b border-zinc-800">
                  <span className="text-white font-medium">{entity}</span>
                  <span className="text-zinc-500 text-sm ml-2">{rets[0]?.tax_entity?.form_type} · {rets[0]?.tax_entity?.ein}</span>
                </div>

                <table className="w-full text-sm">
                  <thead className="bg-zinc-800/30">
                    <tr>
                      <th className="text-left px-4 py-2 text-xs text-zinc-500">Year</th>
                      <th className="text-right px-4 py-2 text-xs text-zinc-500">Gross Profit</th>
                      <th className="text-right px-4 py-2 text-xs text-zinc-500">Total Income</th>
                      <th className="text-right px-4 py-2 text-xs text-zinc-500">Deductions</th>
                      <th className="text-right px-4 py-2 text-xs text-zinc-500">Taxable Inc</th>
                      <th className="text-right px-4 py-2 text-xs text-zinc-500">Tax</th>
                      <th className="text-right px-4 py-2 text-xs text-zinc-500">Status</th>
                      <th className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rets.sort((a, b) => b.tax_year - a.tax_year).map(r => {
                      const c = r.computed_data?.computed || {}
                      return (
                        <tr key={r.id} className="border-t border-zinc-800/50 hover:bg-zinc-800/20 cursor-pointer"
                          onClick={() => setSelected(selected?.id === r.id ? null : r)}>
                          <td className="px-4 py-2.5">
                            <span className="text-indigo-400 font-mono">{r.tax_year}</span>
                            {r.is_amended && <span className="ml-1 text-xs text-yellow-500">amended</span>}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-zinc-400">{c.gross_profit ? fmt(c.gross_profit) : '—'}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-zinc-400">{c.total_income ? fmt(c.total_income) : '—'}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-zinc-400">{c.total_deductions ? fmt(c.total_deductions) : '—'}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-white">{c.taxable_income !== undefined ? fmt(c.taxable_income) : (c.ordinary_income_loss !== undefined ? fmt(c.ordinary_income_loss) : '—')}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-white">{c.income_tax ? fmt(c.income_tax) : (c.tax_due !== undefined ? fmt(c.tax_due) : '—')}</td>
                          <td className="px-4 py-2.5 text-right">
                            <span className={`px-2 py-0.5 rounded-full text-xs ${r.status === 'computed' ? 'bg-green-900/50 text-green-400' : r.status === 'verified' ? 'bg-blue-900/50 text-blue-400' : 'bg-zinc-800 text-zinc-500'}`}>{r.status}</span>
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <ChevronDown size={14} className={`text-zinc-600 transition-transform ${selected?.id === r.id ? 'rotate-180' : ''}`} />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>

                {/* Expanded breakdown */}
                {selected && byEntity[entity]?.find(r => r.id === selected.id) && (
                  <div className="border-t border-zinc-800 p-4 bg-zinc-800/20">
                    <h4 className="text-sm font-medium text-white mb-3">
                      {selected.tax_year} {selected.form_type} — Line-by-Line
                    </h4>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-xs text-zinc-500 mb-2 uppercase">Computed by Engine</p>
                        <div className="space-y-1 text-sm">
                          {Object.entries(selected.computed_data?.computed || {}).filter(([, v]) => typeof v === 'number').map(([k, v]) => (
                            <div key={k} className="flex justify-between">
                              <span className="text-zinc-500">{k.replace(/_/g, ' ')}</span>
                              <span className="font-mono text-zinc-300">{fmt(v as number)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div>
                        <p className="text-xs text-zinc-500 mb-2 uppercase">Extracted from Return</p>
                        {selected.field_values ? (
                          <div className="space-y-1 text-sm max-h-60 overflow-y-auto">
                            {Object.entries(selected.field_values).filter(([, v]) => typeof v === 'number' && v !== 0).map(([k, v]) => (
                              <div key={k} className="flex justify-between">
                                <span className="text-zinc-500 text-xs">{k}</span>
                                <span className="font-mono text-zinc-400 text-xs">{fmt(v as number)}</span>
                              </div>
                            ))}
                          </div>
                        ) : <p className="text-zinc-600 text-xs">No extracted data</p>}
                      </div>
                    </div>
                    {selected.verification?.discrepancies?.length > 0 && (
                      <div className="mt-3 p-2 bg-red-950/20 border border-red-900/20 rounded">
                        <p className="text-xs text-red-400 font-medium mb-1">Discrepancies</p>
                        {selected.verification.discrepancies.map((d: any, i: number) => (
                          <p key={i} className="text-xs text-red-300">{d.field}: extracted {fmt(d.extracted)} vs computed {fmt(d.computed)} (Δ {fmt(d.delta)})</p>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      ) : (
        /* Forms library */
        <div className="bg-zinc-900 border border-zinc-800 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-800/50"><tr>
              <th className="text-left px-4 py-2 text-xs text-zinc-500 uppercase">Form</th>
              <th className="text-left px-4 py-2 text-xs text-zinc-500 uppercase">Name</th>
              <th className="text-left px-4 py-2 text-xs text-zinc-500 uppercase">Years</th>
              <th className="text-left px-4 py-2 text-xs text-zinc-500 uppercase">Maps</th>
            </tr></thead>
            <tbody>
              {forms && Object.entries(forms).map(([k, v]: [string, any]) => (
                <tr key={k} className="border-t border-zinc-800">
                  <td className="px-4 py-2 font-mono text-indigo-400 text-xs">{k}</td>
                  <td className="px-4 py-2">{v.name}</td>
                  <td className="px-4 py-2 text-zinc-500 text-xs">{v.years?.join(', ')}</td>
                  <td className="px-4 py-2 text-xs">{v.maps?.length ? <span className="text-green-400">{v.maps.join(', ')}</span> : <span className="text-zinc-600">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
