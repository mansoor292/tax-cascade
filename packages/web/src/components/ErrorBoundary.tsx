import { Component, type ReactNode } from 'react'

/**
 * Stops one broken page from taking the whole app with it.
 *
 * Without this, a render-time throw anywhere unmounts the entire React tree:
 * the user gets a pure white page — no nav, no message, no way back except
 * knowing to edit the URL. That is exactly what /app/compare/:id did when the
 * comparison endpoint answered with a shape that had no all_rows.
 *
 * A crash is still a bug to fix. This only ensures the person in front of it
 * can see that something went wrong and keep using the rest of the product.
 */
type Props = { children: ReactNode }
type State = { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error('[ErrorBoundary]', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="p-8 max-w-lg">
        <h2 className="text-lg font-semibold text-white mb-2">Something went wrong on this page</h2>
        <p className="text-sm text-zinc-400 mb-4">
          The rest of the app is still working — use the menu to carry on, or reload to try again.
        </p>
        <pre className="text-xs text-red-400 bg-zinc-900 border border-zinc-800 rounded p-3 overflow-x-auto mb-4">
          {this.state.error.message}
        </pre>
        <div className="flex gap-2">
          <button
            onClick={() => this.setState({ error: null })}
            className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-white rounded text-sm"
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-sm"
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
