/**
 * Error Boundary Component
 * Catches React errors and logs them to backend
 */
import React from 'react';
import logger from '../utils/logger';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    // Log error to our logging service
    logger.error('React Error Boundary Caught Error', {
      error: error.toString(),
      stack: error.stack,
      componentStack: errorInfo.componentStack
    });

    this.setState({
      error,
      errorInfo
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '40px',
          maxWidth: '600px',
          margin: '100px auto',
          textAlign: 'center',
          fontFamily: 'system-ui, -apple-system, sans-serif'
        }}>
          <h1 style={{ color: '#e74c3c', marginBottom: '20px' }}>
            Oops! Something went wrong
          </h1>
          <p style={{ color: '#666', marginBottom: '30px' }}>
            The application encountered an unexpected error.
            The error has been logged and we'll look into it.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '12px 24px',
              fontSize: '16px',
              backgroundColor: '#3498db',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Reload Page
          </button>

          {process.env.NODE_ENV === 'development' && this.state.error && (
            <details style={{
              marginTop: '30px',
              textAlign: 'left',
              padding: '20px',
              backgroundColor: '#f5f5f5',
              borderRadius: '4px'
            }}>
              <summary style={{ cursor: 'pointer', fontWeight: 'bold', marginBottom: '10px' }}>
                Error Details (Development Only)
              </summary>
              <pre style={{
                fontSize: '12px',
                overflow: 'auto',
                color: '#e74c3c'
              }}>
                {this.state.error.toString()}
                {'\n\n'}
                {this.state.errorInfo.componentStack}
              </pre>
            </details>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
