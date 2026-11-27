import { Component } from 'react'
import type { ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { failed: boolean }

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State { return { failed: true } }

  render() {
    if (this.state.failed) return <main className="app-error-boundary" role="alert"><div><span className="tiny-label">NODARA</span><h1>This page ran into a problem.</h1><p>Your account and event data have not been changed by this screen error.</p><button type="button" onClick={() => window.location.reload()}>Reload page</button></div></main>
    return this.props.children
  }
}
