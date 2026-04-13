import { useEffect, useState } from 'react'
import { auth } from '../lib/api'
import { Copy, Trash2, Plus } from 'lucide-react'

interface ApiKey {
  id: string; name: string; key_value: string; is_active: boolean; created_at: string; last_used_at: string | null
}

export default function Settings() {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const d = await auth.me()
      setKeys(d.api_keys || [])
    } catch {}
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const create = async () => {
    const name = prompt('Key name:')
    if (!name) return
    try {
      const d = await auth.createKey(name)
      alert(`API Key created:\n\n${d.api_key.key_value}\n\nCopy this now.`)
      load()
    } catch (e: any) { alert('Error: ' + e.message) }
  }

  const revoke = async (id: string) => {
    if (!confirm('Revoke this key? It cannot be undone.')) return
    await auth.revokeKey(id)
    load()
  }

  const copy = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold text-white">API Keys</h2>
        <button onClick={create} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md text-sm">
          <Plus size={14} /> New Key
        </button>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-md overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-800/50">
            <tr>
              <th className="text-left px-4 py-3 text-xs text-zinc-500 uppercase">Name</th>
              <th className="text-left px-4 py-3 text-xs text-zinc-500 uppercase">Key</th>
              <th className="text-left px-4 py-3 text-xs text-zinc-500 uppercase">Status</th>
              <th className="text-left px-4 py-3 text-xs text-zinc-500 uppercase">Last Used</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-500">Loading...</td></tr>
            ) : keys.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-500">No API keys. Create one to get started.</td></tr>
            ) : keys.map(k => (
              <tr key={k.id} className="border-t border-zinc-800">
                <td className="px-4 py-3">{k.name}</td>
                <td className="px-4 py-3 font-mono text-xs text-zinc-400">
                  {k.key_value}
                  <button onClick={() => copy(k.key_value)} className="ml-2 text-zinc-600 hover:text-zinc-300">
                    <Copy size={12} />
                  </button>
                </td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs ${k.is_active ? 'bg-green-900/50 text-green-400' : 'bg-zinc-800 text-zinc-500'}`}>
                    {k.is_active ? 'active' : 'revoked'}
                  </span>
                </td>
                <td className="px-4 py-3 text-zinc-500 text-xs">{k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : 'never'}</td>
                <td className="px-4 py-3">
                  {k.is_active && (
                    <button onClick={() => revoke(k.id)} className="text-zinc-600 hover:text-red-400"><Trash2 size={14} /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-8">
        <h3 className="text-sm font-medium text-zinc-400 mb-2">Usage</h3>
        <pre className="bg-zinc-900 border border-zinc-800 rounded-md p-4 text-xs text-zinc-400 overflow-x-auto">
{`curl -X POST https://tax-api.catalogshub.com/api/compute/1120 \\
  -H "x-api-key: YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"gross_receipts": 1000000, "tax_year": 2024, ...}'`}
        </pre>
      </div>
    </div>
  )
}
