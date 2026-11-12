import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { EmptyState } from "@/components/EmptyState";

interface BoundaryProps {
  title: string;
  /** A new value clears the failure, so the next navigation gets a fresh attempt at rendering. */
  resetKey: string;
  children: ReactNode;
}

class Boundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("The page failed to render:", error, info.componentStack);
  }

  componentDidUpdate(previous: BoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (!this.state.failed) {
      return this.props.children;
    }
    return (
      <div className="card">
        <EmptyState title={this.props.title} action={<Link className="btn" to="/errors">Back to issues</Link>}>
          Something in this page's data could not be read. The rest of eKeeper is unaffected.
        </EmptyState>
      </div>
    );
  }
}

/**
 * Keeps a render error in one routed page from blanking the whole app: React unmounts the entire tree when
 * nothing catches a render error, which is what an event with `"user":"null"` did before the payload parsing
 * was tightened. The sidebar and the shell stay, and navigating anywhere (any new location key) retries. Used
 * around the routed content in ProtectedLayout, and again around the issue detail route for its own wording.
 */
export function RouteErrorBoundary({ title, children }: { title: string; children: ReactNode }) {
  const location = useLocation();
  return (
    <Boundary title={title} resetKey={location.key}>
      {children}
    </Boundary>
  );
}
