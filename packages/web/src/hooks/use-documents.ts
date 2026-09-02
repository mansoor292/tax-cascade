import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

export interface Document {
  id: string
  entity_id?: string
  filename: string
  s3_path: string
  doc_type: string
  tax_year?: number
  file_size?: number
  uploaded_at?: string
  // The list endpoint returns counts only; the full Textract blob is available
  // from GET /api/documents/:id or the list endpoint with ?full=1.
  textract_summary?: {
    num_pages?: number | null
    kv_count?: number
    table_count?: number
  } | null
  textract_status?: string
  /** 'processing' while classification and extraction run after upload. */
  processing_status?: 'processing' | 'done' | 'failed'
  processing_error?: string
  gemini_classification?: Record<string, unknown>
  meta?: {
    summary?: string
    entity_name?: string
    ein_or_ssn?: string
    key_values?: Record<string, unknown>
  }
}

export function useDocuments(entityId?: string) {
  const [documents, setDocuments] = useState<Document[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api<{ documents: Document[] }>('/api/documents')
      const filtered = entityId
        ? (data.documents || []).filter(d => d.entity_id === entityId)
        : data.documents || []
      setDocuments(filtered)
    } catch (e: unknown) {
      setDocuments([])
      setError(e instanceof Error ? e.message : 'Failed to load documents')
    }
    setLoading(false)
  }, [entityId])

  useEffect(() => { load() }, [load])

  /** Poll while anything is still being extracted, then stop. */
  useEffect(() => {
    if (!documents.some(d => d.processing_status === 'processing')) return
    const t = setInterval(() => { load() }, 3000)
    return () => clearInterval(t)
  }, [documents, load])

  const upload = async (
    file: File,
    onProgress?: (status: string) => void
  ) => {
    onProgress?.('Getting upload URL...')
    const presign = await api<{ upload_url: string; s3_key: string; content_type: string }>(
      `/api/documents/presign?filename=${encodeURIComponent(file.name)}`
    )

    onProgress?.('Uploading file...')
    await fetch(presign.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': presign.content_type },
      body: file,
    })

    onProgress?.('Saving...')
    // entity_id MUST be sent. This hook already knows the entity — it uses
    // entityId to filter the list below — but register was never told, so
    // every upload was stored with entity_id null and then filtered out of
    // the very view that uploaded it. The file was safe; it was attached to
    // nothing, and the user was shown a success toast and an empty list.
    // Answers 202 as soon as the file is stored; classification and extraction
    // continue in the background and the list polls until they land. Waiting
    // for them here is what produced a 504 on any sizeable return.
    const doc = await api<{ document: Document; processing?: boolean }>('/api/documents/register', {
      method: 'POST',
      body: JSON.stringify({
        s3_key: presign.s3_key,
        filename: file.name,
        file_size: file.size,
        entity_id: entityId,
      }),
    })

    await load()
    return doc.document
  }

  const process = async (documentId: string, formType?: string, taxYear?: number) => {
    return api('/api/returns/process/' + documentId, {
      method: 'POST',
      body: JSON.stringify({ form_type: formType, tax_year: taxYear }),
    })
  }

  const download = async (documentId: string) => {
    // Response field is `url` (routes/documents.ts:74). The LIST endpoint
    // returns `download_url` per row, which is how this drifted — typed
    // wrong here, the download button silently no-oped.
    return api<{ url: string }>(`/api/documents/${documentId}/download`)
  }

  const remove = async (documentId: string) => {
    await api(`/api/documents/${documentId}`, { method: 'DELETE' })
    await load()
  }

  /** Re-run the intake pipeline (mapper + archiveFiledReturn + Gemini gap-fill)
   *  on a prior_return_* document using its stored Textract data. */
  const rearchive = async (documentId: string) => {
    return api<{ rearchived: { id: string; mapped_fields: number; unmapped_count: number; totals: Record<string, number | null> } }>(
      `/api/documents/${documentId}/rearchive`,
      { method: 'POST' },
    )
  }

  return { documents, loading, error, reload: load, upload, process, download, remove, rearchive }
}
