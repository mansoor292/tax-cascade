import { useState } from 'react'
import { forms } from '../lib/api'

export default function Returns() {
  const [formList, setFormList] = useState<any>(null)

  const loadForms = async () => {
    const d = await forms.list()
    setFormList(d)
  }

  if (!formList) loadForms()

  return (
    <div>
      <h2 className="text-xl font-semibold text-white mb-4">Returns & Forms</h2>

      <div className="bg-zinc-900 border border-zinc-800 rounded-md overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-800/50">
            <tr>
              <th className="text-left px-4 py-3 text-xs text-zinc-500 uppercase">Form</th>
              <th className="text-left px-4 py-3 text-xs text-zinc-500 uppercase">Name</th>
              <th className="text-left px-4 py-3 text-xs text-zinc-500 uppercase">Years</th>
              <th className="text-left px-4 py-3 text-xs text-zinc-500 uppercase">Field Maps</th>
            </tr>
          </thead>
          <tbody>
            {formList && Object.entries(formList).map(([key, val]: [string, any]) => (
              <tr key={key} className="border-t border-zinc-800">
                <td className="px-4 py-3 font-mono text-indigo-400">{key}</td>
                <td className="px-4 py-3">{val.name}</td>
                <td className="px-4 py-3 text-zinc-400">{val.years?.join(', ')}</td>
                <td className="px-4 py-3">
                  {val.maps?.length > 0 ? (
                    <span className="text-green-400 text-xs">{val.maps.join(', ')}</span>
                  ) : (
                    <span className="text-zinc-600 text-xs">none</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-zinc-600 text-xs mt-4">
        19 forms supported across 2020-2025. 41 Textract-verified field maps.
      </p>
    </div>
  )
}
