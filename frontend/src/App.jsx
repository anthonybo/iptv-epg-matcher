import React, { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { Provider } from 'react-redux';
import { store } from './store';
import { sseManager, getSessionId } from './api/apiSlice';
import ChannelsView from './components/ChannelsView';
import LoadData from './pages/LoadData/LoadData';
import { setCurrentSession } from './services/ApiService';
import SimpleCategories from './SimpleCategories';

// Add a SessionContext to share session info throughout the app
export const SessionContext = React.createContext();

function App() {
  const [isSessionIdReady, setIsSessionIdReady] = useState(false);
  const [sessionId, setSessionId] = useState(null);

  // Initialize session ID and SSE connection on app load
  useEffect(() => {
    console.log('[App] Initializing...');
    // Ensure a valid session ID exists before proceeding
    const currentSessionId = getSessionId(); // Call the function to ensure generation if needed
    console.log(`[App] Session ID check complete. ID: ${currentSessionId}`);
    setSessionId(currentSessionId);
    setIsSessionIdReady(true); // Mark session ID as ready

    // Connect to SSE stream *after* confirming session ID
    console.log(`[App] Establishing SSE connection with session ID: ${currentSessionId}`);
    sseManager.connect();
    
    // ... (keep existing SSE listeners if needed) ...
    const unsubscribeAll = sseManager.addEventListener('all', (data) => {
      console.debug('[App SSE Event]:', data);
    });

    // Clean up on unmount
    return () => {
      console.log('[App] Cleaning up SSE connection.');
      unsubscribeAll();
      sseManager.disconnect();
    };
  }, []); // Run only once on initial mount
  
  // Display loading indicator until session ID is ready
  if (!isSessionIdReady) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-slate-950 text-slate-200">
        <span className="h-12 w-12 animate-spin rounded-full border-2 border-blue-500 border-t-transparent"></span>
        <p className="mt-4 text-sm text-slate-400">Initializing session...</p>
      </div>
    );
  }

  // Update session ID handler - will be passed to components that need to update the session
  const updateSessionId = (newSessionId) => {
    if (newSessionId) {
      setSessionId(newSessionId);
      setCurrentSession(newSessionId);
      console.log(`App session updated: ${newSessionId}`);
    }
  };

  // Render the main application only when session ID is ready
  return (
    <Provider store={store}>
      <SessionContext.Provider value={{ sessionId, updateSessionId }}>
        <Router>
          <div className="min-h-screen bg-slate-950 text-slate-100">
            <Routes>
              <Route path="/" element={<LoadData onSessionUpdate={updateSessionId} />} />
              <Route path="/channels" element={<ChannelsView sessionId={sessionId} />} />
              <Route path="/categories" element={<SimpleCategories />} />
            </Routes>
          </div>
        </Router>
      </SessionContext.Provider>
    </Provider>
  );
}

export default App;
