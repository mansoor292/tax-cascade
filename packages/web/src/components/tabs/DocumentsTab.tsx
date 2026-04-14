import { useState, useRef, useCallback } from 'react'
import {
  Upload,
  FileText,
  Trash2,
  Loader2,
  Download,
  Zap,
  ChevronDown,
} from 'lucide-react'
import { useDocuments, type Document } from '@/hooks/use-documents'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'

const DOC_TYPE_LABELS: Record<string, string> = {
  w2: 'W-2',
  '1099': '1099',
  k1: 'K-1',
  prior_return_1040: '1040 Return',
  prior_return_1120: '1120 Return',
  prior_return_1120s: '1120-S Return',
  bank_statement: 'Bank Statement',
  invoice: 'Invoice',
  receipt: 'Receipt',
  tax_transcript: 'Tax Transcript',
  other: 'Other',
}

const DOC_TYPE_VARIANT: Record<string, string> = {
  w2: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  '1099': 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
  k1: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  prior_return_1040: 'bg-green-500/10 text-green-400 border-green-500/20',
  prior_return_1120: 'bg-green-500/10 text-green-400 border-green-500/20',
  prior_return_1120s: 'bg-green-500/10 text-green-400 border-green-500/20',
  bank_statement: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  tax_transcript: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
}

interface Props {
  entityId: string
}

export default function DocumentsTab({ entityId }: Props) {
  const { documents, loading, upload, process, download, remove } = useDocuments(entityId)
  const [uploading, setUploading] = useState(false)
  const [uploadStatus, setUploadStatus] = useState('')
  const [processing, setProcessing] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        await upload(file, setUploadStatus)
        toast.success(`Uploaded ${file.name}`)
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Upload failed')
    }
    setUploading(false)
    setUploadStatus('')
    if (fileRef.current) fileRef.current.value = ''
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    handleFiles(e.dataTransfer.files)
  }, [])

  const handleProcess = async (docId: string) => {
    setProcessing(docId)
    try {
      await process(docId)
      toast.success('Document processed into return')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Processing failed')
    }
    setProcessing(null)
  }

  const handleDownload = async (docId: string) => {
    try {
      const data = await download(docId)
      if (data.download_url) window.open(data.download_url, '_blank')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Download failed')
    }
  }

  const handleDelete = async (docId: string, filename: string) => {
    if (!confirm(`Delete ${filename}?`)) return
    try {
      await remove(docId)
      toast.success(`Deleted ${filename}`)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  if (loading) {
    return <div className="space-y-3">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-20" />)}</div>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium">Documents</h3>
        <div className="flex items-center gap-2">
          {uploadStatus && <span className="text-xs text-muted-foreground">{uploadStatus}</span>}
          <Button
            size="sm"
            className="gap-2"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Upload
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.csv,.xlsx"
            multiple
            onChange={e => handleFiles(e.target.files)}
            className="hidden"
          />
        </div>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
          dragOver ? 'border-primary bg-primary/5' : 'border-border'
        }`}
      >
        <Upload className="h-8 w-8 text-muted-foreground/50 mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">
          Drag & drop tax documents here, or{' '}
          <button onClick={() => fileRef.current?.click()} className="text-primary underline">browse</button>
        </p>
        <p className="text-xs text-muted-foreground/60 mt-1">
          PDF, images, CSV, Excel — W-2s, 1099s, K-1s, prior returns
        </p>
      </div>

      {documents.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">No documents uploaded yet.</p>
      ) : (
        <div className="space-y-2">
          {documents.map((doc: Document) => (
            <Card key={doc.id}>
              <CardContent className="p-3 sm:p-4">
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <FileText className="h-5 w-5 text-muted-foreground shrink-0 hidden sm:block" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm truncate">{doc.filename}</span>
                        <Badge variant="outline" className={DOC_TYPE_VARIANT[doc.doc_type] || ''}>
                          {DOC_TYPE_LABELS[doc.doc_type] || doc.doc_type}
                        </Badge>
                        {doc.tax_year && (
                          <Badge variant="outline" className="text-xs">
                            {doc.tax_year}
                          </Badge>
                        )}
                      </div>
                      {doc.meta?.summary && (
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">{doc.meta.summary}</p>
                      )}
                      {doc.meta?.entity_name && (
                        <p className="text-xs text-muted-foreground/60">
                          {doc.meta.entity_name}
                          {doc.meta.ein_or_ssn ? ` · ${doc.meta.ein_or_ssn}` : ''}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {doc.textract_data && (
                      <span className="text-xs text-muted-foreground mr-2">
                        {doc.textract_data.num_pages || '?'}p · {doc.textract_data.kvs?.length || 0} fields
                      </span>
                    )}
                    {doc.doc_type?.startsWith('prior_return') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleProcess(doc.id)}
                        disabled={processing === doc.id}
                        className="gap-1 text-xs"
                      >
                        {processing === doc.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                        Process
                      </Button>
                    )}
                    <Button variant="ghost" size="icon" onClick={() => handleDownload(doc.id)}>
                      <Download className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(doc.id, doc.filename)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                    {doc.meta?.key_values && Object.keys(doc.meta.key_values).length > 0 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setExpanded(expanded === doc.id ? null : doc.id)}
                      >
                        <ChevronDown className={`h-4 w-4 transition-transform ${expanded === doc.id ? 'rotate-180' : ''}`} />
                      </Button>
                    )}
                  </div>
                </div>

                {expanded === doc.id && doc.meta?.key_values && (
                  <div className="mt-3 pt-3 border-t grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    {Object.entries(doc.meta.key_values).map(([k, v]) => (
                      <div key={k} className="flex justify-between">
                        <span className="text-muted-foreground capitalize">{k.replace(/_/g, ' ')}</span>
                        <span className="font-mono">
                          {typeof v === 'number' ? `$${v.toLocaleString()}` : String(v)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
