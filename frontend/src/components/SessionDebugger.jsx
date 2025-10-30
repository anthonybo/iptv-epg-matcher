import React, { useEffect, useMemo, useState } from 'react';
import { API_BASE_URL } from '../config';

const overlayStyle = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15, 23, 42, 0.55)',
  zIndex: 1300,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center'
};

const modalStyle = {
  width: 'min(960px, 94vw)',
  maxHeight: '92vh',
  background: '#ffffff',
  borderRadius: '16px',
  boxShadow: '0 24px 80px rgba(15, 23, 42, 0.25)',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column'
};

const headerStyle = {
  padding: '20px 26px',
  background: 'linear-gradient(135deg, #1e3a8a, #2563eb)',
  color: '#ffffff',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between'
};

const bodyStyle = {
  padding: '24px',
  overflowY: 'auto',
  flex: 1,
  background: '#f8fafc'
};

const footerStyle = {
  padding: '18px 24px',
  borderTop: '1px solid rgba(148, 163, 184, 0.25)',
  background: '#ffffff',
  display: 'flex',
  gap: '12px',
  flexWrap: 'wrap'
};

const cardStyle = {
  padding: '18px',
  borderRadius: '12px',
  background: '#ffffff',
  boxShadow: '0 14px 36px rgba(15, 23, 42, 0.08)'
};

const resolveApiBase = () => {
  if (API_BASE_URL) {
    return API_BASE_URL;
  }

  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:5001`;
  }

  return 'http://localhost:5001';
};

const SessionDebugger = ({ isOpen, onClose }) => {
  const [sessionInfo, setSessionInfo] = useState({
    fromLocalStorage: null,
    fromSessionManager: null,
    fromWindow: null
  });
  const [categoriesCount, setCategoriesCount] = useState(0);
  const [apiResponse, setApiResponse] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const activeSessionId = useMemo(() => (
    sessionInfo.fromSessionManager || sessionInfo.fromLocalStorage || sessionInfo.fromWindow || ''
  ), [sessionInfo]);

  useEffect(() => {
    if (!isOpen) {
      return () => {};
    }

    let isMounted = true;

    const gatherSessionInfo = async () => {
      try {
        const fromLocalStorage = localStorage.getItem('currentSessionId') || localStorage.getItem('sessionId');

        let fromSessionManager = null;
        try {
          const SessionManagerModule = await import('../utils/sessionManager');
          fromSessionManager = SessionManagerModule.default.getSessionId();
        } catch (moduleError) {
          console.error('[SessionDebugger] Unable to load SessionManager:', moduleError);
        }

        const fromWindow = window.sessionManager?.getCurrentSession?.() || null;

        if (!isMounted) return;
        setSessionInfo({ fromLocalStorage, fromSessionManager, fromWindow });

        const candidateSession = fromSessionManager || fromLocalStorage || fromWindow;
        if (!candidateSession) {
          setCategoriesCount(0);
          setApiResponse('No session detected in local sources.');
          setLoading(false);
          return;
        }

        const baseUrl = resolveApiBase();
        const response = await fetch(`${baseUrl}/api/channels/${candidateSession}/categories?_t=${Date.now()}`);
        const text = await response.text();
        if (!isMounted) return;

        setApiResponse(text);

        try {
          const parsed = JSON.parse(text);
          const categoriesArray = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.categories) ? parsed.categories : [];
          setCategoriesCount(categoriesArray.length);
        } catch (parseError) {
          console.error('[SessionDebugger] Failed to parse category response:', parseError);
          setError(`Parse error: ${parseError.message}`);
        }
        setLoading(false);
      } catch (fetchError) {
        if (!isMounted) return;
        console.error('[SessionDebugger] Error fetching session data:', fetchError);
        setError(fetchError.message);
        setLoading(false);
      }
    };

    gatherSessionInfo();
    const interval = setInterval(gatherSessionInfo, 5000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [isOpen]);

  const handleRefresh = async () => {
    if (!activeSessionId) {
      setError('No session ID available for refresh');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const baseUrl = resolveApiBase();
      const response = await fetch(`${baseUrl}/api/channels/${activeSessionId}/categories?_t=${Date.now()}`);
      const text = await response.text();
      setApiResponse(text);
      const parsed = JSON.parse(text);
      const categoriesArray = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.categories) ? parsed.categories : [];
      setCategoriesCount(categoriesArray.length);
    } catch (refreshError) {
      console.error('[SessionDebugger] Refresh error:', refreshError);
      setError(refreshError.message);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) {
    return null;
  }

  const statusMessage = loading
    ? 'Syncing session data…'
    : error
      ? `Error: ${error}`
      : categoriesCount > 0
        ? `Active categories: ${categoriesCount}`
        : 'No categories found';

  return (
    <div style={overlayStyle}>
      <div style={modalStyle} role="dialog" aria-modal="true" aria-labelledby="session-debugger-title">
        <div style={headerStyle}>
          <div>
            <div id="session-debugger-title" style={{ fontSize: '18px', fontWeight: 600 }}>Session Debugger</div>
            <div style={{ fontSize: '13px', opacity: 0.85 }}>{statusMessage}</div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close debugger"
            style={{
              border: 'none',
              background: 'rgba(255,255,255,0.18)',
              color: '#ffffff',
              width: '34px',
              height: '34px',
              borderRadius: '50%',
              fontSize: '18px',
              cursor: 'pointer'
            }}
          >
            ×
          </button>
        </div>

        <div style={bodyStyle}>
          <section style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '16px',
            marginBottom: '20px'
          }}>
            <div style={cardStyle}>
              <div style={{ fontSize: '13px', color: '#64748b', marginBottom: '6px' }}>localStorage</div>
              <div style={{ fontWeight: 600, wordBreak: 'break-word', color: '#0f172a' }}>{sessionInfo.fromLocalStorage || 'Not found'}</div>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: '13px', color: '#64748b', marginBottom: '6px' }}>SessionManager</div>
              <div style={{ fontWeight: 600, wordBreak: 'break-word', color: '#0f172a' }}>{sessionInfo.fromSessionManager || 'Not found'}</div>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: '13px', color: '#64748b', marginBottom: '6px' }}>Window global</div>
              <div style={{ fontWeight: 600, wordBreak: 'break-word', color: '#0f172a' }}>{sessionInfo.fromWindow || 'Not found'}</div>
            </div>
          </section>

          <section style={{
            background: '#ffffff',
            borderRadius: '14px',
            boxShadow: '0 18px 40px rgba(15, 23, 42, 0.1)'
          }}>
            <header style={{
              padding: '14px 18px',
              borderBottom: '1px solid rgba(148, 163, 184, 0.2)',
              background: '#eef2ff',
              fontWeight: 600,
              fontSize: '14px',
              color: '#312e81'
            }}>
              API Response Preview
            </header>
            <pre style={{
              maxHeight: '260px',
              overflow: 'auto',
              margin: 0,
              padding: '18px',
              background: '#0f172a',
              color: '#cbd5f5',
              fontSize: '12px',
              lineHeight: 1.6,
              fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
            }}>
              {apiResponse || 'No data'}
            </pre>
          </section>
        </div>

        <div style={footerStyle}>
          <button
            onClick={handleRefresh}
            disabled={loading}
            style={{
              padding: '10px 18px',
              borderRadius: '8px',
              border: 'none',
              background: '#2563eb',
              color: '#ffffff',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontWeight: 500
            }}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>

          <button
            onClick={() => {
              localStorage.removeItem('sessionId');
              localStorage.removeItem('currentSessionId');
              window.location.reload();
            }}
            style={{
              padding: '10px 18px',
              borderRadius: '8px',
              border: '1px solid rgba(239,68,68,0.5)',
              background: '#fee2e2',
              color: '#b91c1c',
              cursor: 'pointer',
              fontWeight: 500
            }}
          >
            Clear Session & Reload
          </button>

          <div style={{ marginLeft: 'auto', fontSize: '12px', color: '#64748b' }}>
            Tips: check the console, verify the backend, or clear browser cache.
          </div>
        </div>
      </div>
    </div>
  );
};

export default SessionDebugger;
