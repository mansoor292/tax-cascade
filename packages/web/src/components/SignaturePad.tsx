/**
 * Where an 8821 signer draws their signature (mouse, finger or pen). The
 * drawing goes to the API as a PNG and is placed on line 6 of the signed
 * copy (api services/f8821.ts signed8821). Reports null until something has
 * been drawn, so a blank pad cannot sign.
 */
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'

export default function SignaturePad({ onChange, label = 'Draw your signature' }: { onChange: (png: string | null) => void; label?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const inked = useRef(0)

  useEffect(() => {
    const c = ref.current!
    // Draw at device resolution so the signature is crisp on the form.
    const scale = window.devicePixelRatio || 1
    c.width = c.clientWidth * scale
    c.height = c.clientHeight * scale
    const ctx = c.getContext('2d')!
    ctx.scale(scale, scale)
    ctx.lineWidth = 2.2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#111'
  }, [])

  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top] as const
  }
  const clear = () => {
    const c = ref.current!
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height)
    inked.current = 0
    onChange(null)
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm" id="sigpad-label">{label}</span>
      <canvas
        ref={ref}
        role="img"
        aria-labelledby="sigpad-label"
        className="w-full h-32 rounded-md border bg-white touch-none cursor-crosshair"
        onPointerDown={e => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drawing.current = true
          const ctx = e.currentTarget.getContext('2d')!
          const [x, y] = at(e)
          ctx.beginPath()
          ctx.moveTo(x, y)
        }}
        onPointerMove={e => {
          if (!drawing.current) return
          const ctx = e.currentTarget.getContext('2d')!
          const [x, y] = at(e)
          ctx.lineTo(x, y)
          ctx.stroke()
          inked.current++
        }}
        onPointerUp={() => {
          drawing.current = false
          // A few points is a tap, not a signature.
          onChange(inked.current > 8 ? ref.current!.toDataURL('image/png') : null)
        }}
      />
      <div><Button type="button" variant="ghost" size="sm" onClick={clear}>Clear</Button></div>
    </div>
  )
}
