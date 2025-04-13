import React, { useState, useEffect } from 'react';
import { Box, Typography, Paper, List, ListItem, ListItemText, Divider, IconButton } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { sseManager } from '../api/apiSlice';

/**
 * Real-time SSE Event Monitor for debugging
 * Shows all events coming through the SSE connection
 */
const SSEMonitor = () => {
  const [events, setEvents] = useState([]);
  const [connected, setConnected] = useState(false);
  
  useEffect(() => {
    // Monitor connection status
    const checkConnection = () => {
      const isConnected = sseManager.eventSource && sseManager.eventSource.readyState === 1;
      setConnected(isConnected);
    };
    
    checkConnection();
    const connectionCheckInterval = setInterval(checkConnection, 2000);
    
    // Set up all-events listener
    const unsubscribe = sseManager.addEventListener('all', (data) => {
      setEvents(prev => {
        const newEvents = [...prev, {
          id: Date.now(),
          time: new Date().toLocaleTimeString(),
          ...data
        }];
        
        // Keep only the last 50 events for performance
        if (newEvents.length > 50) {
          return newEvents.slice(newEvents.length - 50);
        }
        return newEvents;
      });
    });
    
    // Clean up
    return () => {
      clearInterval(connectionCheckInterval);
      unsubscribe();
    };
  }, []);
  
  const clearEvents = () => {
    setEvents([]);
  };
  
  return (
    <Paper elevation={3} sx={{ p: 2, maxHeight: '400px', overflow: 'hidden', mb: 2 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
        <Typography variant="h6">
          SSE Event Monitor
          <Box 
            component="span" 
            sx={{ 
              display: 'inline-block',
              width: 10,
              height: 10,
              borderRadius: '50%',
              bgcolor: connected ? 'success.main' : 'error.main',
              ml: 1
            }} 
          />
        </Typography>
        <Box>
          <Typography variant="caption" sx={{ mr: 2 }}>
            {connected ? 'Connected' : 'Disconnected'}
          </Typography>
          <IconButton size="small" onClick={clearEvents}>
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Box>
      </Box>
      
      <Divider sx={{ mb: 1 }} />
      
      <Box sx={{ overflowY: 'auto', maxHeight: '320px' }}>
        {events.length === 0 ? (
          <Typography variant="body2" sx={{ p: 2, textAlign: 'center', color: 'text.secondary' }}>
            Waiting for events...
          </Typography>
        ) : (
          <List dense>
            {events.map((event) => (
              <ListItem key={event.id} divider>
                <ListItemText
                  primary={
                    <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                      <Typography variant="subtitle2" component="span">
                        {event.type}
                      </Typography>
                      <Typography variant="caption" component="span">
                        {event.time}
                      </Typography>
                    </Box>
                  }
                  secondary={
                    <Box component="pre" sx={{ 
                      mt: 1, 
                      p: 1, 
                      bgcolor: 'background.paper',
                      fontSize: '0.75rem',
                      overflow: 'auto',
                      maxHeight: '100px',
                      borderRadius: 1
                    }}>
                      {JSON.stringify(event, null, 2)}
                    </Box>
                  }
                />
              </ListItem>
            ))}
          </List>
        )}
      </Box>
    </Paper>
  );
};

export default SSEMonitor;