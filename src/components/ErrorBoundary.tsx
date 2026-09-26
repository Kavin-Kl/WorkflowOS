import { Component, type ReactNode } from 'react'

/** Shows the error instead of a blank window if rendering throws. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="page">
        <div className="kicker">Something broke</div>
        <h1 style={{ fontFamily: 'var(--serif)', fontWeight: 500 }}>WorkFlowOS hit an error</h1>
        <pre className="card card-pad mono" style={{ whiteSpace: 'pre-wrap' }}>
          {this.state.error.message}
          {'\n\n'}
          {this.state.error.stack}
        </pre>
        <button className="btn primary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}
