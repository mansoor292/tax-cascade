import { useState } from 'react'
import { api } from '../lib/api'

export default function Compute() {
  const [form, setForm] = useState('1120')
  const [input, setInput] = useState('{\n  "gross_receipts": 1000000,\n  "cost_of_goods_sold": 200000,\n  "salaries_wages": 300000,\n  "taxes_licenses": 20000,\n  "other_deductions": 100000,\n  "estimated_tax_paid": 0,\n  "tax_year": 2024\n}')
  const [result, setResult] = useState<any>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async () => {
    setBusy(true); setErr(''); setResult(null)
    try {
      const data = JSON.parse(input)
      // Fill in defaults for required fields
      const defaults: Record<string, any> = { returns_allowances: 0, dividends: 0, interest_income: 0, gross_rents: 0, gross_royalties: 0, capital_gains: 0, net_gain_4797: 0, other_income: 0, officer_compensation: 0, repairs_maintenance: 0, bad_debts: 0, rents: 0, interest_expense: 0, charitable_contrib: 0, depreciation: 0, depletion: 0, advertising: 0, pension_plans: 0, employee_benefits: 0, nol_deduction: 0, special_deductions: 0 }
      const merged = { ...defaults, ...data }
      const r = await api(`/api/compute/${form}`, { method: 'POST', body: JSON.stringify(merged) })
      setResult(r)
    } catch (e: any) { setErr(e.message) }
    setBusy(false)
  }

  const c = result?.result?.computed
  return (
    <div>
      <h2 className="text-lg font-semibold text-white mb-4">Compute Return</h2>
      <div className="flex gap-2 mb-3">
        {[['1120', 'C-Corp'], ['1120s', 'S-Corp'], ['1040', 'Individual']].map(([k, v]) => (
          <button key={k} onClick={() => setForm(k)}
            className={`px-3 py-1.5 rounded text-sm ${form === k ? 'bg-indigo-600 text-white' : 'bg-zinc-800 text-zinc-400'}`}>{v}</button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <textarea value={input} onChange={e => setInput(e.target.value)} rows={16}
            className="w-full p-3 bg-zinc-900 border border-zinc-800 rounded text-sm font-mono text-zinc-300 focus:outline-none focus:border-indigo-500 resize-none" />
          <button onClick={run} disabled={busy}
            className="mt-2 px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-sm font-medium disabled:opacity-50">
            {busy ? 'Computing...' : 'Compute'}
          </button>
        </div>
        <div>
          {err && <p className="text-red-400 text-sm mb-2">{err}</p>}
          {c && (
            <div className="bg-zinc-900 border border-zinc-800 rounded p-4 text-sm space-y-1">
              {Object.entries(c).filter(([, v]) => typeof v === 'number').map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-zinc-500">{k.replace(/_/g, ' ')}</span>
                  <span className={`font-mono ${k.includes('tax') || k.includes('income') ? 'text-white font-medium' : 'text-zinc-400'}`}>
                    ${(v as number).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
          {result && (
            <details className="mt-3"><summary className="text-xs text-zinc-600 cursor-pointer">Raw JSON</summary>
              <pre className="mt-1 text-xs text-zinc-500 bg-zinc-900 p-3 rounded overflow-auto max-h-48">{JSON.stringify(result, null, 2)}</pre>
            </details>
          )}
        </div>
      </div>
    </div>
  )
}
