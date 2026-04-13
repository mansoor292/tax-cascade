import { useEffect, useState } from 'react'
import { api } from '../lib/api'

export default function Returns() {
  const [forms, setForms] = useState<any>(null)
  useEffect(() => { api('/api/forms').then(setForms).catch(() => {}) }, [])
  return (
    <div>
      <h2 className="text-lg font-semibold text-white mb-4">Forms & Field Maps</h2>
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
    </div>
  )
}
