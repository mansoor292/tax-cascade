import { toast as sonner } from 'sonner'

/**
 * Toasts, with errors that wait to be read.
 *
 * Reported from testing: an upload failed, the error appeared and vanished
 * before it could be read, and the only remaining evidence was that nothing
 * had happened. Sonner dismisses after ~4s by default, which is fine for
 * "Saved" and wrong for the one message that tells you what went wrong —
 * especially when the toast is the ONLY place the failure is reported.
 *
 * So errors and warnings stay until dismissed; confirmations still fade.
 * Import from here rather than from sonner directly so this holds everywhere.
 */
type ToastOpts = Parameters<typeof sonner.error>[1]

const persist = (opts?: ToastOpts): ToastOpts => ({
  duration: Infinity,
  closeButton: true,
  ...opts,
})

export const toast = Object.assign(
  (message: Parameters<typeof sonner>[0], opts?: ToastOpts) => sonner(message, opts),
  sonner,
  {
    error: (message: Parameters<typeof sonner.error>[0], opts?: ToastOpts) =>
      sonner.error(message, persist(opts)),
    warning: (message: Parameters<typeof sonner.warning>[0], opts?: ToastOpts) =>
      sonner.warning(message, persist(opts)),
  },
)
