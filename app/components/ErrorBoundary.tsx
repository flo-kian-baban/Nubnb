"use client";

import React, { Component, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Global error boundary for uncaught render errors.
 * Displays a branded fullscreen fallback — not a white screen.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#0A0A0C",
          fontFamily: "var(--font-sans), -apple-system, BlinkMacSystemFont, sans-serif",
        }}>
          <div style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "20px",
            maxWidth: "360px",
            padding: "48px 40px",
            borderRadius: "20px",
            background: "rgba(255, 255, 255, 0.04)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            textAlign: "center",
            animation: "errorBoundaryEnter 0.5s cubic-bezier(0.22, 1, 0.36, 1) both",
          }}>
            {/* Branded monogram */}
            <div style={{
              width: "56px",
              height: "56px",
              borderRadius: "50%",
              background: "rgba(101, 153, 205, 0.12)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#6599CD",
              fontSize: "1.25rem",
              fontWeight: 700,
              letterSpacing: "0.05em",
            }}>
              N
            </div>

            <h2 style={{
              fontSize: "1.25rem",
              fontWeight: 600,
              color: "#fff",
              letterSpacing: "-0.01em",
              margin: 0,
            }}>
              Something unexpected happened
            </h2>

            <p style={{
              fontSize: "0.875rem",
              color: "rgba(255, 255, 255, 0.5)",
              lineHeight: 1.6,
              margin: 0,
            }}>
              We hit an error loading this page. A reload usually fixes it.
            </p>

            <button
              onClick={this.handleReload}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                marginTop: "4px",
                padding: "10px 24px",
                borderRadius: "999px",
                background: "#6599CD",
                color: "#fff",
                fontSize: "0.8125rem",
                fontWeight: 600,
                letterSpacing: "0.01em",
                border: "none",
                cursor: "pointer",
                transition: "all 0.3s ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "#5080B4";
                e.currentTarget.style.transform = "translateY(-1px)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "#6599CD";
                e.currentTarget.style.transform = "translateY(0)";
              }}
            >
              <RefreshCw size={16} />
              Reload Page
            </button>
          </div>

          <style>{`
            @keyframes errorBoundaryEnter {
              from { opacity: 0; transform: translateY(12px) scale(0.97); }
              to   { opacity: 1; transform: translateY(0) scale(1); }
            }
          `}</style>
        </div>
      );
    }

    return this.props.children;
  }
}
