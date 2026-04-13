import { useState } from 'react'
import { compute } from '../lib/api'

const PRESETS: Record<string, any> = {
  '1120': {
    gross_receipts: 1651448, returns_allowances: 0, cost_of_goods_sold: 148060,
    dividends: 0, interest_income: 2, gross_rents: 0, gross_royalties: 0,
    capital_gains: 0, net_gain_4797: 0, other_income: 0,
    officer_compensation: 0, salaries_wages: 594779, repairs_maintenance: 0,
    bad_debts: 0, rents: 0, taxes_licenses: 33515, interest_expense: 0,
    charitable_contrib: 1050, depreciation: 8040, depletion: 0, advertising: 9175,
    pension_plans: 0, employee_benefits: 0, other_deductions: 165820,
    nol_deduction: 0, special_deductions: 0, estimated_tax_paid: 292825, tax_year: 2024,
  },
  '1120s': {
    gross_receipts: 2169999, returns_allowances: 0, cost_of_goods_sold: 653861,
    net_gain_4797: 0, other_income: 52300,
    officer_compensation: 60000, salaries_wages: 177802, repairs_maintenance: 5506,
    bad_debts: 0, rents: 21060, taxes_licenses: 13030, interest: 0,
    depreciation: 0, depletion: 0, advertising: 600000, pension_plans: 0,
    employee_benefits: 0, other_deductions: 529033,
    charitable_contrib: 0, section_179: 0,
    shareholders: [{ name: 'Mansoor Razzaq', pct: 100 }],
  },
}

export default function Compute() {
  const [form, setForm] = useState('1120')
  const [input, setInput] = useState(JSON.stringify(PRESETS['1120'], null, 2))
  const [result, setResult] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleFormChange = (f: string) => {
    setForm(f)
    if (PRESETS[f]) setInput(JSON.stringify(PRESETS[f], null, 2))
    setResult(null)
  }

  const handleCompute = async () => {
    setLoading(true); setError(''); setResult(null)
    try {
      const data = JSON.parse(input)
      const fn = form === '1120' ? compute.form1120 : form === '1120s' ? compute.form1120s : compute.form1040
      const r = await fn(data)
      setResult(r)
    } catch (e: any) { setError(e.message) }
    setLoading(false)
  }

  const c = result?.result?.computed
  return (
    <div>
      <h2 className="text-xl font-semibold text-white mb-4">Compute Return</h2>

      <div className="flex gap-3 mb-4">
        {['1120', '1120s', '1040'].map(f => (
          <button key={f} onClick={() => handleFormChange(f)}
            className={`px-4 py-2 rounded-md text-sm ${form === f ? 'bg-indigo-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-white'}`}>
            {f === '1120' ? '1120 C-Corp' : f === '1120s' ? '1120-S S-Corp' : '1040 Individual'}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-sm text-zinc-500 mb-1 block">Input (JSON)</label>
          <textarea value={input} onChange={e => setInput(e.target.value)} rows={20}
            className="w-full p-3 bg-zinc-900 border border-zinc-800 rounded-md text-sm font-mono text-zinc-300 focus:outline-none focus:border-indigo-500 resize-none" />
          <button onClick={handleCompute} disabled={loading}
            className="mt-3 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md text-sm font-medium disabled:opacity-50">
            {loading ? 'Computing...' : 'Compute'}
          </button>
        </div>

        <div>
          <label className="text-sm text-zinc-500 mb-1 block">Result</label>
          {error && <p className="text-red-400 text-sm mb-2">{error}</p>}

          {c && (
            <div className="space-y-2">
              {form === '1120' && (
                <div className="bg-zinc-900 border border-zinc-800 rounded-md p-4 space-y-1 text-sm">
                  <Row label="Gross Profit" val={c.gross_profit} />
                  <Row label="Total Income" val={c.total_income} />
                  <Row label="Total Deductions" val={c.total_deductions} />
                  <div className="border-t border-zinc-800 my-2" />
                  <Row label="TI before NOL" val={c.taxable_income_before_nol} />
                  <Row label="Taxable Income" val={c.taxable_income} bold />
                  <Row label="Tax (21%)" val={c.income_tax} bold />
                  <div className="border-t border-zinc-800 my-2" />
                  <Row label="Total Payments" val={c.total_payments} />
                  <Row label="Overpayment" val={c.overpayment} green />
                  <Row label="Balance Due" val={c.balance_due} red />
                </div>
              )}
              {form === '1120s' && (
                <div className="bg-zinc-900 border border-zinc-800 rounded-md p-4 space-y-1 text-sm">
                  <Row label="Gross Profit" val={c.gross_profit} />
                  <Row label="Total Income" val={c.total_income} />
                  <Row label="Total Deductions" val={c.total_deductions} />
                  <Row label="Ordinary Income" val={c.ordinary_income_loss} bold />
                  <div className="border-t border-zinc-800 my-2" />
                  {c.k1s?.map((k: any, i: number) => (
                    <div key={i} className="pl-3 border-l-2 border-indigo-600">
                      <p className="text-zinc-500 text-xs">K-1 → {k.name}</p>
                      <Row label="Ordinary Income" val={k.ordinary_income} />
                      <Row label="W-2 Wages (QBI)" val={k.w2_wages} />
                    </div>
                  ))}
                </div>
              )}

              <details className="bg-zinc-900 border border-zinc-800 rounded-md p-3">
                <summary className="text-xs text-zinc-500 cursor-pointer">Raw JSON</summary>
                <pre className="mt-2 text-xs text-zinc-400 overflow-auto max-h-60">{JSON.stringify(result, null, 2)}</pre>
              </details>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Row({ label, val, bold, green, red }: { label: string; val?: number; bold?: boolean; green?: boolean; red?: boolean }) {
  if (val === undefined || val === null) return null
  const color = green && val > 0 ? 'text-green-400' : red && val > 0 ? 'text-red-400' : 'text-zinc-300'
  return (
    <div className={`flex justify-between ${bold ? 'font-semibold' : ''}`}>
      <span className="text-zinc-500">{label}</span>
      <span className={color}>${val.toLocaleString()}</span>
    </div>
  )
}
