import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { Copy, Trash2, Plus } from 'lucide-react'

export default function Keys() {
  const [keys, setKeys] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  const load = () => { setLoading(true); api('/auth/me').then(d => setKeys(d.api_keys || [])).catch(() => {}).finally(() => setLoading(false)) }
  useEffect(() => { load() }, [])

  const create = async () => {
    const name = prompt('Key name:')
    if (!name) return
    try {
      const d = await api('/auth/api-keys', { method: 'POST', body: JSON.stringify({ name }) })
      alert(`API Key:\n\n${d.api_key.key_value}\n\nCopy now — won't be shown in full again.`)
      load()
    } catch (e: any) { alert(e.message) }
  }

  const revoke = async (id: string) => {
    if (!confirm('Revoke?')) return
    await api(`/auth/api-keys/${id}`, { method: 'DELETE' })
    load()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">API Keys</h2>
        <button onClick={create} className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-sm"><Plus size={14} />New Key</button>
      </div>
      <div className="bg-zinc-900 border border-zinc-800 rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-800/50"><tr>
            <th className="text-left px-4 py-2 text-xs text-zinc-500 uppercase">Name</th>
            <th className="text-left px-4 py-2 text-xs text-zinc-500 uppercase">Key</th>
            <th className="text-left px-4 py-2 text-xs text-zinc-500 uppercase">Status</th>
            <th className="px-4 py-2"></th>
          </tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={4} className="px-4 py-6 text-center text-zinc-600">Loading...</td></tr>
            : !keys.length ? <tr><td colSpan={4} className="px-4 py-6 text-center text-zinc-600">No keys yet. Create one to use the API.</td></tr>
            : keys.map(k => (
              <tr key={k.id} className="border-t border-zinc-800">
                <td className="px-4 py-2.5">{k.name}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-zinc-500">
                  {k.key_value}
                  <button onClick={() => navigator.clipboard.writeText(k.key_value)} className="ml-2 text-zinc-700 hover:text-zinc-400"><Copy size={11} /></button>
                </td>
                <td className="px-4 py-2.5">
                  <span className={`px-2 py-0.5 rounded-full text-xs ${k.is_active ? 'bg-green-900/50 text-green-400' : 'bg-zinc-800 text-zinc-600'}`}>{k.is_active ? 'active' : 'revoked'}</span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  {k.is_active && <button onClick={() => revoke(k.id)} className="text-zinc-700 hover:text-red-400"><Trash2 size={13} /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-6">
        <p className="text-xs text-zinc-600 mb-2">Usage</p>
        <pre className="bg-zinc-900 border border-zinc-800 rounded p-3 text-xs text-zinc-500 overflow-x-auto">
{`curl -H "x-api-key: YOUR_KEY" https://tax-api.catalogshub.com/api/compute/1120 \\
  -H "Content-Type: application/json" -d '{"gross_receipts": 1000000, ...}'`}
        </pre>
      </div>
    </div>
  )
}
