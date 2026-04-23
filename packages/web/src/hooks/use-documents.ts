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
  textract_data?: {
    num_pages?: number
    kvs?: { key: string; value: string }[]
    tables?: Array<{ row_count?: number; col_count?: number }>
  }
  textract_status?: string
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

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api<{ documents: Document[] }>('/api/documents')
      const filtered = entityId
        ? (data.documents || []).filter(d => d.entity_id === entityId)
        : data.documents || []
      setDocuments(filtered)
    } catch {
      setDocuments([])
    }
    setLoading(false)
  }, [entityId])

  useEffect(() => { load() }, [load])

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

    onProgress?.('Classifying and extracting...')
    const doc = await api<{ document: Document }>('/api/documents/register', {
      method: 'POST',
      body: JSON.stringify({ s3_key: presign.s3_key, filename: file.name, file_size: file.size }),
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
    return api<{ download_url: string }>(`/api/documents/${documentId}/download`)
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

  return { documents, loading, reload: load, upload, process, download, remove, rearchive }
}
