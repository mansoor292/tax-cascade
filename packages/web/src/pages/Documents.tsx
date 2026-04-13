import { useEffect, useState, useRef } from 'react'
import { api } from '../lib/api'
import { Upload, FileText, Trash2, Loader2 } from 'lucide-react'

const DOC_TYPE_LABELS: Record<string, string> = {
  w2: 'W-2', '1099': '1099', k1: 'K-1',
  prior_return_1040: '1040 Return', prior_return_1120: '1120 Return', prior_return_1120s: '1120-S Return',
  bank_statement: 'Bank Statement', invoice: 'Invoice', receipt: 'Receipt',
  tax_transcript: 'Tax Transcript', other: 'Other',
}

const DOC_TYPE_COLORS: Record<string, string> = {
  w2: 'bg-blue-900/50 text-blue-300', '1099': 'bg-cyan-900/50 text-cyan-300',
  k1: 'bg-purple-900/50 text-purple-300',
  prior_return_1040: 'bg-green-900/50 text-green-300', prior_return_1120: 'bg-green-900/50 text-green-300',
  prior_return_1120s: 'bg-green-900/50 text-green-300',
  bank_statement: 'bg-yellow-900/50 text-yellow-300', tax_transcript: 'bg-orange-900/50 text-orange-300',
  other: 'bg-zinc-800 text-zinc-400',
}

export default function Documents() {
  const [docs, setDocs] = useState<any[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadStatus, setUploadStatus] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const load = () => api('/api/documents').then(d => setDocs(d.documents || [])).catch(() => {})
  useEffect(() => { load() }, [])

  const upload_ = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      setUploadStatus('Getting upload URL...')
      const presign = await api(`/api/documents/presign?filename=${encodeURIComponent(file.name)}`)

      setUploadStatus('Uploading to S3...')
      await fetch(presign.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': presign.content_type },
        body: file,
      })

      setUploadStatus('Classifying with AI + extracting with Textract...')
      await api('/api/documents/register', {
        method: 'POST',
        body: JSON.stringify({ s3_key: presign.s3_key, filename: file.name, file_size: file.size }),
      })

      setUploadStatus('')
      load()
    } catch (err: any) { alert(err.message); setUploadStatus('') }
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  const del = async (id: string) => {
    if (!confirm('Delete this document?')) return
    await api(`/api/documents/${id}`, { method: 'DELETE' })
    load()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Documents</h2>
        <div className="flex items-center gap-3">
          {uploadStatus && <span className="text-xs text-zinc-500">{uploadStatus}</span>}
          <label className={`flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-sm cursor-pointer ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {uploading ? 'Processing...' : 'Upload'}
            <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.csv,.xlsx" onChange={upload_} className="hidden" disabled={uploading} />
          </label>
        </div>
      </div>

      {!docs.length ? (
        <div className="text-center py-16 text-zinc-600">
          <FileText size={40} className="mx-auto mb-3 text-zinc-700" />
          <p>No documents yet. Upload a tax document to get started.</p>
          <p className="text-xs mt-1">Supports PDF, images, CSV, Excel</p>
        </div>
      ) : (
        <div className="space-y-2">
          {docs.map(d => (
            <div key={d.id} className="bg-zinc-900 border border-zinc-800 rounded p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <FileText size={18} className="text-zinc-600" />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-white text-sm font-medium">{d.filename}</span>
                      <span className={`px-2 py-0.5 rounded-full text-xs ${DOC_TYPE_COLORS[d.doc_type] || DOC_TYPE_COLORS.other}`}>
                        {DOC_TYPE_LABELS[d.doc_type] || d.doc_type}
                      </span>
                      {d.tax_year && <span className="px-2 py-0.5 rounded-full text-xs bg-indigo-900/50 text-indigo-300">{d.tax_year}</span>}
                    </div>
                    {d.meta?.summary && <p className="text-zinc-500 text-xs mt-0.5">{d.meta.summary}</p>}
                    {d.meta?.entity_name && <p className="text-zinc-600 text-xs">{d.meta.entity_name} {d.meta?.ein_or_ssn ? `· ${d.meta.ein_or_ssn}` : ''}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {d.textract_data && (
                    <span className="text-xs text-green-500">{d.textract_data.num_pages || '?'} pages · {d.textract_data.kvs?.length || 0} fields</span>
                  )}
                  <button onClick={() => del(d.id)} className="text-zinc-700 hover:text-red-400"><Trash2 size={13} /></button>
                </div>
              </div>

              {d.meta?.key_values && Object.keys(d.meta.key_values).length > 0 && (
                <details className="mt-2">
                  <summary className="text-xs text-zinc-600 cursor-pointer">Key values</summary>
                  <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    {Object.entries(d.meta.key_values).map(([k, v]) => (
                      <div key={k} className="flex justify-between">
                        <span className="text-zinc-500">{k.replace(/_/g, ' ')}</span>
                        <span className="text-zinc-300 font-mono">{typeof v === 'number' ? `$${(v as number).toLocaleString()}` : String(v)}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {d.textract_data?.kvs && (
                <details className="mt-2">
                  <summary className="text-xs text-zinc-600 cursor-pointer">Textract data ({d.textract_data.kvs.length} fields)</summary>
                  <pre className="mt-1 text-xs text-zinc-500 bg-zinc-800/50 p-2 rounded overflow-auto max-h-32">
                    {d.textract_data.kvs.slice(0, 20).map((kv: any) => `${kv.key}: ${kv.value}`).join('\n')}
                    {d.textract_data.kvs.length > 20 ? `\n... and ${d.textract_data.kvs.length - 20} more` : ''}
                  </pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
