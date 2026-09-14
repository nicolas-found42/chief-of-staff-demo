import { Component, Suspense, type ReactNode } from "react";

/** Lazy modules cache failures as well as successes. Reloading explicitly
 * obtains the current asset manifest after a deployment or interrupted load;
 * the Shell navigation stays usable while this page reports the failure. */
export class PageLoadingBoundary extends Component<
  { children: ReactNode; pathname: string },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidUpdate(previous: Readonly<{ children: ReactNode; pathname: string }>) {
    // Reset failures on navigation without remounting a healthy route's state.
    if (previous.pathname !== this.props.pathname && this.state.failed)
      this.setState({ failed: false });
  }

  override render() {
    if (this.state.failed)
      return (
        <section role="alert">
          <h1>This page could not load</h1>
          <p>Reload to try again. Your saved work remains in the Workspace.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </section>
      );
    return (
      <Suspense
        fallback={
          <div role="status">
            <h1>Loading page…</h1>
          </div>
        }
      >
        {this.props.children}
      </Suspense>
    );
  }
}
