import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { Sparkles, Play, Plus } from 'lucide-react'

export default function Scenarios() {
  const [list, setList] = useState<any[]>([])
  const [showNew, setShowNew] = useState(false)
  const [name, setName] = useState(''); const [desc, setDesc] = useState('')
  const [year, setYear] = useState('2024'); const [adj, setAdj] = useState('{}')
  const [busy, setBusy] = useState(false)

  const load = () => api('/api/scenarios').then(d => setList(d.scenarios || [])).catch(() => {})
  useEffect(() => { load() }, [])

  const create = async () => {
    setBusy(true)
    try {
      const d = await api('/api/scenarios', { method: 'POST', body: JSON.stringify({ name, description: desc, tax_year: +year, adjustments: JSON.parse(adj) }) })
      if (d.scenario) await api(`/api/scenarios/${d.scenario.id}/compute`, { method: 'POST' })
      setShowNew(false); setName(''); setDesc(''); setAdj('{}'); load()
    } catch (e: any) { alert(e.message) }
    setBusy(false)
  }

  const analyze = async (id: string) => {
    try { await api(`/api/scenarios/${id}/analyze`, { method: 'POST' }); load() }
    catch (e: any) { alert(e.message) }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Scenarios</h2>
        <button onClick={() => setShowNew(!showNew)} className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-sm"><Plus size={14} />New</button>
      </div>
      {showNew && (
        <div className="bg-zinc-900 border border-zinc-800 rounded p-4 mb-4 space-y-2">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-white text-sm focus:outline-none focus:border-indigo-500" />
          <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder="Description" rows={2} className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-white text-sm resize-none focus:outline-none focus:border-indigo-500" />
          <select value={year} onChange={e => setYear(e.target.value)} className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-white text-sm">
            <option>2025</option><option>2024</option><option>2023</option><option>2022</option>
          </select>
          <textarea value={adj} onChange={e => setAdj(e.target.value)} rows={6} placeholder="Adjustments JSON" className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-white text-sm font-mono resize-none focus:outline-none focus:border-indigo-500" />
          <button onClick={create} disabled={busy || !name} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-sm disabled:opacity-50">{busy ? '...' : 'Create & Compute'}</button>
        </div>
      )}
      <div className="space-y-3">
        {!list.length && <p className="text-zinc-600 text-sm py-8 text-center">No scenarios yet</p>}
        {list.map(s => (
          <div key={s.id} className="bg-zinc-900 border border-zinc-800 rounded p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-white font-medium">{s.name}</span>
                <span className="px-2 py-0.5 rounded-full text-xs bg-indigo-900/50 text-indigo-300">{s.tax_year}</span>
                <span className={`px-2 py-0.5 rounded-full text-xs ${s.status === 'computed' ? 'bg-green-900/50 text-green-400' : 'bg-zinc-800 text-zinc-500'}`}>{s.status}</span>
              </div>
              <div className="flex gap-2">
                <button onClick={() => api(`/api/scenarios/${s.id}/compute`, { method: 'POST' }).then(load)} className="flex items-center gap-1 px-2 py-1 bg-zinc-800 text-zinc-400 hover:text-white rounded text-xs"><Play size={11} />Run</button>
                <button onClick={() => analyze(s.id)} className="flex items-center gap-1 px-2 py-1 bg-purple-900/40 text-purple-300 hover:bg-purple-800/40 rounded text-xs"><Sparkles size={11} />AI</button>
              </div>
            </div>
            {s.description && <p className="text-zinc-500 text-xs mb-2">{s.description}</p>}
            {s.computed_result && <details><summary className="text-xs text-zinc-600 cursor-pointer">Result</summary><pre className="mt-1 text-xs text-zinc-500 bg-zinc-800/50 p-2 rounded overflow-auto max-h-32">{JSON.stringify(s.computed_result?.computed || s.computed_result, null, 2)}</pre></details>}
            {s.ai_analysis && <div className="mt-2 p-3 bg-purple-950/20 border border-purple-900/20 rounded text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">{s.ai_analysis}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}
