import { useEffect, useState } from 'react'
import { scenarios } from '../lib/api'
import { FlaskConical, Sparkles, Play } from 'lucide-react'

export default function Scenarios() {
  const [list, setList] = useState<any[]>([])
  const [showNew, setShowNew] = useState(false)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [year, setYear] = useState('2024')
  const [adjustments, setAdjustments] = useState('{}')
  const [loading, setLoading] = useState(false)

  const load = async () => {
    try {
      const d = await scenarios.list()
      setList(d.scenarios || [])
    } catch {}
  }

  useEffect(() => { load() }, [])

  const create = async () => {
    setLoading(true)
    try {
      const d = await scenarios.create({
        name, description: desc, tax_year: parseInt(year),
        adjustments: JSON.parse(adjustments),
      })
      if (d.scenario) {
        await scenarios.compute(d.scenario.id)
      }
      setShowNew(false); setName(''); setDesc(''); setAdjustments('{}')
      load()
    } catch (e: any) { alert(e.message) }
    setLoading(false)
  }

  const analyze = async (id: string) => {
    try {
      await scenarios.analyze(id)
      load()
    } catch (e: any) { alert(e.message) }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold text-white">Scenarios</h2>
        <button onClick={() => setShowNew(!showNew)}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md text-sm">
          <FlaskConical size={14} /> New Scenario
        </button>
      </div>

      {showNew && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-md p-4 mb-4 space-y-3">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Scenario name"
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-md text-white text-sm focus:outline-none focus:border-indigo-500" />
          <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder="Description" rows={2}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-md text-white text-sm focus:outline-none focus:border-indigo-500 resize-none" />
          <select value={year} onChange={e => setYear(e.target.value)}
            className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-md text-white text-sm">
            <option>2025</option><option>2024</option><option>2023</option><option>2022</option>
          </select>
          <textarea value={adjustments} onChange={e => setAdjustments(e.target.value)} rows={8} placeholder="Adjustments JSON"
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-md text-white text-sm font-mono focus:outline-none focus:border-indigo-500 resize-none" />
          <button onClick={create} disabled={loading || !name}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md text-sm disabled:opacity-50">
            {loading ? 'Creating...' : 'Create & Compute'}
          </button>
        </div>
      )}

      <div className="space-y-3">
        {list.length === 0 ? (
          <p className="text-zinc-500 text-sm py-8 text-center">No scenarios yet. Create one to model different tax outcomes.</p>
        ) : list.map(s => (
          <div key={s.id} className="bg-zinc-900 border border-zinc-800 rounded-md p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="font-medium text-white">{s.name}</span>
                <span className="px-2 py-0.5 rounded-full text-xs bg-indigo-900/50 text-indigo-300">{s.tax_year}</span>
                <span className={`px-2 py-0.5 rounded-full text-xs ${s.status === 'computed' ? 'bg-green-900/50 text-green-400' : 'bg-zinc-800 text-zinc-500'}`}>{s.status}</span>
              </div>
              <div className="flex gap-2">
                <button onClick={() => scenarios.compute(s.id).then(load)}
                  className="flex items-center gap-1 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-xs">
                  <Play size={12} /> Recompute
                </button>
                <button onClick={() => analyze(s.id)}
                  className="flex items-center gap-1 px-3 py-1.5 bg-purple-900/50 hover:bg-purple-800/50 text-purple-300 rounded text-xs">
                  <Sparkles size={12} /> AI Analyze
                </button>
              </div>
            </div>
            {s.description && <p className="text-zinc-500 text-sm mb-2">{s.description}</p>}
            {s.computed_result && (
              <details>
                <summary className="text-xs text-zinc-500 cursor-pointer">Computed result</summary>
                <pre className="mt-2 text-xs text-zinc-400 bg-zinc-800/50 p-3 rounded overflow-auto max-h-40">
                  {JSON.stringify(s.computed_result?.computed || s.computed_result, null, 2)}
                </pre>
              </details>
            )}
            {s.ai_analysis && (
              <div className="mt-3 p-3 bg-purple-950/30 border border-purple-900/30 rounded text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">
                {s.ai_analysis}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
