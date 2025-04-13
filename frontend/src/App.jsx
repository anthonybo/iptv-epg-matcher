import React, { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { Provider } from 'react-redux';
import { store } from './store';
import AppRoutes from './routes';
import { ThemeProvider } from './theme/ThemeProvider';
import { sseManager, getSessionId } from './api/apiSlice'; // Import getSessionId function
import { Box, CircularProgress, Typography } from '@mui/material';
import ChannelList from './components/Channels/ChannelList';
import LoadData from './pages/LoadData/LoadData';
import { getCurrentSession, setCurrentSession } from './services/ApiService';
import SimpleCategories from './SimpleCategories'; // Import the new component
import './App.css';

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
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <CircularProgress />
        <Typography sx={{ ml: 2 }}>Initializing session...</Typography>
      </Box>
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
      <ThemeProvider>
        <SessionContext.Provider value={{ sessionId, updateSessionId }}>
          <Router>
            <Routes>
              <Route path="/" element={<LoadData onSessionUpdate={updateSessionId} />} />
              <Route path="/channels" element={<ChannelList page={1} limit={1000} />} />
              <Route path="/categories" element={<SimpleCategories />} />
            </Routes>
          </Router>
        </SessionContext.Provider>
      </ThemeProvider>
    </Provider>
  );
}

export default App;