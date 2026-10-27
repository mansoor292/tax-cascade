/**
 * A PDF drawn page by page onto the page itself (pdf.js), for the signed 8821
 * at the end of a test client's signing (2026-10-27). An <iframe> of the PDF
 * shows nothing where the browser has no PDF viewer of its own — Android
 * Chrome, headless browsers — and only a first page on iOS; drawn pages show
 * everywhere. pdf.js loads only when this mounts.
 */
import { useEffect, useRef, useState } from 'react'

export function PdfPages({ url, title }: { url: string; title: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'shown' | 'failed'>('loading')
  useEffect(() => {
    let gone = false
    ;(async () => {
      try {
        const pdfjs = await import('pdfjs-dist')
        pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
        const data = await (await fetch(url)).arrayBuffer()
        const doc = await pdfjs.getDocument({ data }).promise
        const el = box.current
        if (!el || gone) return
        el.replaceChildren()
        const width = el.clientWidth || 600
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n)
          const base = page.getViewport({ scale: 1 })
          const vp = page.getViewport({ scale: (width / base.width) * (window.devicePixelRatio || 1) })
          const canvas = document.createElement('canvas')
          canvas.width = vp.width; canvas.height = vp.height
          canvas.style.width = '100%'; canvas.style.background = '#fff'; canvas.style.marginBottom = '8px'
          canvas.setAttribute('aria-label', `Page ${n} of ${doc.numPages}`)
          el.appendChild(canvas)
          await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp }).promise
          if (gone) return
        }
        setState('shown')
      } catch {
        if (!gone) setState('failed')
      }
    })()
    return () => { gone = true }
  }, [url])
  return (
    <div>
      <div ref={box} role="group" aria-label={title} className="rounded border overflow-hidden" />
      {state === 'loading' && <p className="text-sm text-muted-foreground">Loading the signed form…</p>}
      {state === 'failed' && <p className="text-sm text-muted-foreground">The form could not be shown here; open it with the link below.</p>}
    </div>
  )
}
