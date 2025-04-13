import React, { useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import { sseManager, SESSION_ID } from '../api/apiSlice'; 
import { 
  addChannel, 
  updateMatchStatus, 
  setChannels, 
  setEpgSources,
  setProgress
} from '../features/channels/channelsSlice';
import { CircularProgress, Box, Typography } from '@mui/material';

const DataLoader = ({ children }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const dispatch = useDispatch();

  useEffect(() => {
    console.log('DataLoader initializing with session ID:', SESSION_ID);
    
    // Set up event listeners for SSE updates
    const unsubscribeConnection = sseManager.addEventListener('connection', (data) => {
      console.log('Connection established:', data);
      setIsConnected(true);
    });

    const unsubscribeProgress = sseManager.addEventListener('progress', (data) => {
      console.log('Progress update:', data);
      dispatch(setProgress(data));
    });

    const unsubscribeChannelsAvailable = sseManager.addEventListener('channels_available', (data) => {
      console.log('Channels available:', data);
      if (data.channelList && Array.isArray(data.channelList)) {
        dispatch(setChannels(data.channelList));
      }
      setIsInitialLoad(false);
    });

    const unsubscribeEpgSourceAvailable = sseManager.addEventListener('epg_source_available', (data) => {
      console.log('EPG source available:', data);
      if (data.source) {
        dispatch(setEpgSources({
          [data.source]: data.sourceDetails || { name: data.source }
        }));
      }
    });

    const unsubscribeComplete = sseManager.addEventListener('complete', (data) => {
      console.log('Processing complete:', data);
      setIsInitialLoad(false);
    });

    const unsubscribeDataReady = sseManager.addEventListener('data_ready', (data) => {
      console.log('Data ready:', data);
      setIsInitialLoad(false);
    });

    // Ensure connection is established
    if (!sseManager.eventSource) {
      sseManager.connect();
    }

    // Clean up on unmount
    return () => {
      unsubscribeConnection();
      unsubscribeProgress();
      unsubscribeChannelsAvailable();
      unsubscribeEpgSourceAvailable();
      unsubscribeComplete();
      unsubscribeDataReady();
    };
  }, [dispatch]);

  // Show loading indicator during initial load
  if (isInitialLoad && !isConnected) {
    return (
      <Box sx={{ 
        display: 'flex', 
        flexDirection: 'column',
        alignItems: 'center', 
        justifyContent: 'center',
        height: '100vh' 
      }}>
        <CircularProgress size={60} />
        <Typography variant="h6" sx={{ mt: 2 }}>
          Connecting to server...
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Session ID: {SESSION_ID}
        </Typography>
      </Box>
    );
  }

  return children;
};

export default DataLoader;