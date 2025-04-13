import React, { useEffect, useState } from 'react';
import { useGetChannelsQuery } from '../api/apiSlice';
import { getSessionId } from '../api/apiSlice'; // Import the FUNCTION
import { Box, Typography, CircularProgress, Alert } from '@mui/material';

const ResultsPage = () => {
  // State to hold the session ID *after* confirming it in this component
  const [confirmedSessionId, setConfirmedSessionId] = useState(null);
  const [attemptedLoad, setAttemptedLoad] = useState(false);

  // Effect to confirm the session ID *once* after mount
  useEffect(() => {
    console.log('[ResultsPage] useEffect running to confirm Session ID.');
    const id = getSessionId();
    console.log(`[ResultsPage] useEffect - ID from getSessionId(): ${id} (type: ${typeof id})`);
    if (id && id !== 'null' && id !== 'undefined') {
      console.log(`[ResultsPage] useEffect - Setting confirmedSessionId: ${id}`);
      setConfirmedSessionId(id);
    } else {
      console.error(`[ResultsPage] useEffect - CRITICAL: Invalid ID found after mount: ${id}`);
      // If ID is invalid *after* mount, something is wrong with localStorage or getSessionId
    }
  }, []); // Empty dependency array: run only once after mount

  // Log component renders
  console.log(`[ResultsPage] Rendering. confirmedSessionId state: ${confirmedSessionId}`);

  // Render loading state until the session ID is confirmed by the useEffect
  if (!confirmedSessionId) {
    console.log('[ResultsPage] Rendering "Confirming session ID..." state.');
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '50vh' }}>
         <CircularProgress />
         <Typography sx={{ ml: 2 }}>Confirming session ID...</Typography>
      </Box>
    );
  }

  // If we have a confirmed ID, render the component that uses the hook
  console.log(`[ResultsPage] Rendering ChannelLoaderWrapper with confirmedSessionId: ${confirmedSessionId}`);
  return <ChannelLoaderWrapper sessionId={confirmedSessionId} />; 
};

// New Wrapper component to isolate the hook call
const ChannelLoaderWrapper = ({ sessionId }) => {
  // This component only renders when ResultsPage has confirmed a valid sessionId
  console.log(`[ChannelLoaderWrapper] Rendering with sessionId prop: ${sessionId}`);

  // Final check before calling the hook
  if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
     console.error(`[ChannelLoaderWrapper] CRITICAL: Invalid sessionId prop received: ${sessionId}. Aborting query.`);
     return <Alert severity="error">Internal Error: Invalid Session ID detected before loading channels.</Alert>;
  }

  const { 
    data: channelsData, 
    isLoading, 
    isError, 
    error 
  } = useGetChannelsQuery(sessionId); // Call hook only with the validated prop

  useEffect(() => {
    console.log(`[ChannelLoaderWrapper] Query status: isLoading=${isLoading}, isError=${isError}`);
    if(isError) console.error('[ChannelLoaderWrapper] Query error:', error);
  }, [isLoading, isError, error]);

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '50vh' }}>
        <CircularProgress />
        <Typography sx={{ ml: 2 }}>Loading channels for session {sessionId}...</Typography>
      </Box>
    );
  }

  if (isError) {
    return (
      <Alert severity="error" sx={{ m: 3 }}>
        Error loading channels: {error?.data?.message || error?.status || 'Unknown error'}
      </Alert>
    );
  }

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h5" gutterBottom>Channels (Session: {sessionId})</Typography>
      {channelsData && channelsData.channels ? (
        <Typography>Display channel list here using channelsData.channels</Typography>
        // <ChannelList channels={channelsData.channels} categories={channelsData.categories} />
      ) : (
        <Typography>No channels found for this session.</Typography>
      )}
    </Box>
  );
};

export default ResultsPage;