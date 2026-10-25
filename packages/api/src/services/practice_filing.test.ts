/** Signing an 8821 (practice_filing.ts): only a verified signer, only once,
 *  only with a drawing, and the name comes from the verified ID. */
import { describe, it, expect } from 'vitest'
import { pngFrom, signable, verifiedName } from './practice_filing.js'
import { scribblePng } from '../lib/scribble_png.js'

const verified = { signer_name: 'Pat Example', id_verified_at: '2026-10-25T14:00:00Z', signed_at: null }

describe('signing the 8821', () => {
  it('waits for the identity check', () => {
    expect(signable({ stage: 'awaiting_signature', signature: null })).toMatch(/verified before they sign/)
    expect(signable({ stage: 'awaiting_signature', signature: { signer_name: 'Pat Example', signed_at: null, id_verified_at: null } })).toMatch(/verified before they sign/)
    expect(signable({ stage: 'awaiting_signature', signature: verified })).toBeNull()
  })
  it('signs once', () => {
    expect(signable({ stage: 'signed', signature: { ...verified, signed_at: '2026-10-25T14:05:00Z' } })).toMatch(/already signed/)
    expect(signable({ stage: 'submitted', signature: verified })).toMatch(/past signing/)
  })
  it('prints the name read off the verified ID, not the one typed', () => {
    expect(verifiedName({ ...verified, signer_name: 'pat example', idv: { status: 'approved', person: { name: 'PATRICIA A EXAMPLE' } } })).toBe('PATRICIA A EXAMPLE')
    // A check staff made on a video call: the name they confirmed.
    expect(verifiedName({ ...verified, id_method: 'staff_video_call' })).toBe('Pat Example')
  })
  it('takes a drawn PNG and nothing else', () => {
    const png = scribblePng()
    expect(pngFrom(`data:image/png;base64,${png.toString('base64')}`).length).toBe(png.length)
    expect(() => pngFrom('')).toThrow(/Draw your signature/)
    expect(() => pngFrom(Buffer.from('%PDF-1.7 not an image at all, padded out past a hundred bytes of nothing useful whatsoever....').toString('base64'))).toThrow(/Draw your signature/)
  })
})
