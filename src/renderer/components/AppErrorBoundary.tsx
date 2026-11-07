/**
 * Global React Error Boundary — catches unhandled render errors
 * and shows a recovery UI instead of a white screen.
 *
 * Must be a class component (React limitation for error boundaries).
 * Placed in main.tsx outside all providers to catch everything.
 *
 * IMPORTANT: Uses hardcoded fallback colors (not CSS variables) to ensure
 * the error UI is always visible, even when CSS hasn't loaded or vars are
 * missing. CSS vars are used as primary with hardcoded fallbacks.
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { i18n } from '@/i18n';
import { describeRendererError, rendererErrorMessage, reportRendererBootEvent } from '@/utils/rendererDiagnostics';

interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: unknown;
}

export default class AppErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: unknown): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: unknown, info: ErrorInfo) {
        // Startup errors can precede App's log sink; unmount also clears it.
        // Use the existing native ingress to preserve these fatal diagnostics.
        reportRendererBootEvent('renderer-react-error', `${describeRendererError(error)}\n${info.componentStack ?? ''}`);
        console.error('[AppErrorBoundary] Unhandled React error:', error, info.componentStack);
    }

    handleReload = () => {
        window.location.reload();
    };

    render() {
        if (!this.state.hasError) {
            return this.props.children;
        }

        const t = i18n.getFixedT(null, 'app');
        // Hardcoded fallback colors ensure visibility even without CSS variables
        return (
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100vh',
                backgroundColor: 'var(--paper, #fafafa)',
                color: 'var(--ink, #1a1a1a)',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Microsoft YaHei UI", sans-serif',
            }}>
                <div style={{
                    maxWidth: 420,
                    padding: 32,
                    borderRadius: 12,
                    backgroundColor: 'var(--paper-inset, #f0f0f0)',
                    textAlign: 'center',
                }}>
                    <h2 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 600 }}>
                        {t('errorBoundary.title')}
                    </h2>
                    <p style={{
                        margin: '0 0 20px',
                        fontSize: 14,
                        color: 'var(--ink-muted, #666)',
                        lineHeight: 1.5,
                    }}>
                        {rendererErrorMessage(this.state.error) || t('errorBoundary.unknown')}
                    </p>
                    <button
                        onClick={this.handleReload}
                        style={{
                            padding: '8px 24px',
                            fontSize: 14,
                            fontWeight: 500,
                            color: '#fff',
                            backgroundColor: 'var(--accent, #2563eb)',
                            border: 'none',
                            borderRadius: 8,
                            cursor: 'pointer',
                        }}
                    >
                        {t('errorBoundary.reload')}
                    </button>
                </div>
            </div>
        );
    }
}
