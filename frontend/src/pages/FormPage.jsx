import React, { useState, useEffect } from 'react';
import { useLoadDataMutation, getSessionId, SESSION_ID, sseManager } from '../api/apiSlice';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  TextField,
  Typography,
  Alert,
  Paper,
  CircularProgress,
  Grid,
  Divider,
  Link
} from '@mui/material';
import { toast } from 'react-toastify';
import useSessionStorage from '../hooks/useSessionStorage';
import QuestionMarkIcon from '@mui/icons-material/QuestionMark';
import ProgressIndicator from '../components/ProgressIndicator';
import SSEMonitor from '../components/SSEMonitor';

const FormPage = () => {
  const [formValues, setFormValues] = useSessionStorage('iptvForm', {
    m3uUrl: '',
    epgUrl: '',
    xtreamUsername: '',
    xtreamPassword: '',
    xtreamServer: ''
  });
  
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState(null);
  const [progressData, setProgressData] = useState({
    progress: 0,
    stage: 'waiting',
    message: 'Enter parameters and submit to begin'
  });
  
  const [loadData, { isLoading }] = useLoadDataMutation();
  const navigate = useNavigate();
  
  // Ensure we have a valid session ID
  useEffect(() => {
    const currentSessionId = getSessionId();
    console.log(`[FormPage] Current session ID: ${currentSessionId}`);
  }, []);

  useEffect(() => {
    // Debug utility to monitor progress data
    if (isProcessing) {
      console.log('[FormPage] Current progress data:', progressData);
    }
  }, [progressData, isProcessing]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    
    try {
      // Clear existing progress state 
      setIsProcessing(true);
      setProgressData({
        progress: 0,
        stage: 'init',
        message: 'Starting processing...'
      });
      
      // Get the current session ID again to ensure it's fresh
      const currentSessionId = getSessionId();
      console.log('[FormPage] Starting data load process with session ID:', currentSessionId);
      
      // Include the session ID in the request
      const dataWithSessionId = {
        ...formValues,
        sessionId: currentSessionId
      };
      
      // Submit the data to the backend
      const response = await loadData(dataWithSessionId).unwrap();
      
      console.log('[FormPage] Load data response:', response);
      
      // Make sure SSE connection is established
      if (!sseManager.eventSource || sseManager.eventSource.readyState !== 1) {
        console.log('[FormPage] SSE connection not established, connecting now...');
        sseManager.connect();
      } else {
        console.log('[FormPage] SSE connection already established');
      }
      
      // Set up event listeners with enhanced debugging
      console.log('[FormPage] Setting up SSE event listeners');
      
      const unsubscribeProgress = sseManager.addEventListener('progress', (data) => {
        console.log('[FormPage] Progress update received:', data);
        setProgressData({
          progress: data.progress || 0,
          stage: data.stage || 'processing',
          message: data.message || 'Processing data...',
          detail: data.detail || ''
        });
      });
      
      // Listen for completion
      const unsubscribeComplete = sseManager.addEventListener('complete', (data) => {
        console.log('[FormPage] Complete event received:', data);
        setIsProcessing(false);
        toast.success('Processing complete! Navigating shortly...');
        
        // Clean up listeners *before* navigation
        unsubscribeProgress();
        unsubscribeComplete();
        unsubscribeError();
        if (unsubscribeAll) unsubscribeAll();

        // Get the *current* session ID right before navigating
        const finalSessionId = getSessionId();
        console.log(`[FormPage] Retrieved finalSessionId before navigation: ${finalSessionId}`);

        // Add a small delay before navigating and pass the ID in state
        setTimeout(() => {
          if (finalSessionId && finalSessionId !== 'null' && finalSessionId !== 'undefined') {
            console.log(`[FormPage] Navigating to /results with sessionId: ${finalSessionId}`);
            navigate('/results', { state: { sessionId: finalSessionId } });
          } else {
            console.error('[FormPage] Cannot navigate: finalSessionId is invalid!', finalSessionId);
            setError('Failed to navigate: Invalid session ID detected after processing.');
          }
        }, 500); // Delay navigation by 500ms
      });
      
      // Listen for errors
      const unsubscribeError = sseManager.addEventListener('error', (data) => {
        console.error('[FormPage] Error event received:', data);
        setIsProcessing(false);
        setError(data.message || 'An error occurred during processing');
        toast.error(data.message || 'Processing failed');
        
        // Clean up listeners
        unsubscribeProgress();
        unsubscribeComplete();
        unsubscribeError();
        if (unsubscribeAll) unsubscribeAll();
      });
      
      // Set up a catch-all listener for debugging
      const unsubscribeAll = sseManager.addEventListener('all', (data) => {
        console.log('[FormPage] Catch-all event listener received:', data);
      });
      
      // Clean up the catch-all listener after a timeout
      setTimeout(() => {
        if (unsubscribeAll) unsubscribeAll();
      }, 30000); // Keep it for 30 seconds
      
    } catch (err) {
      console.error('[FormPage] Error submitting form:', err);
      setError(err.data?.error || err.message || 'Failed to submit data');
      toast.error(err.data?.error || err.message || 'An error occurred');
      setIsProcessing(false);
    }
  };
  
  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', p: 3 }}>
      <Typography variant="h4" component="h1" gutterBottom sx={{ mb: 3 }}>
        IPTV EPG Matcher
      </Typography>
      
      {/* Add SSE Monitor for debugging */}
      <SSEMonitor />
      
      {error && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {error}
        </Alert>
      )}
      
      {isProcessing ? (
        <ProgressIndicator progressData={progressData} />
      ) : (
        <Paper elevation={3} sx={{ p: 3, mb: 4 }}>
          <form onSubmit={handleSubmit}>
            <Typography variant="h6" gutterBottom>
              IPTV Provider Settings
            </Typography>
            
            <Grid container spacing={3}>
              <Grid item xs={12}>
                <TextField
                  fullWidth
                  label="Xtream Server URL"
                  name="xtreamServer"
                  value={formValues.xtreamServer}
                  onChange={(e) => setFormValues({...formValues, xtreamServer: e.target.value})}
                  placeholder="http://example.com:25461"
                  variant="outlined"
                  helperText="Your Xtream provider server URL including port"
                />
              </Grid>
              
              <Grid item xs={12} md={6}>
                <TextField
                  fullWidth
                  label="Xtream Username"
                  name="xtreamUsername"
                  value={formValues.xtreamUsername}
                  onChange={(e) => setFormValues({...formValues, xtreamUsername: e.target.value})}
                  variant="outlined"
                />
              </Grid>
              
              <Grid item xs={12} md={6}>
                <TextField
                  fullWidth
                  label="Xtream Password"
                  name="xtreamPassword"
                  type="password"
                  value={formValues.xtreamPassword}
                  onChange={(e) => setFormValues({...formValues, xtreamPassword: e.target.value})}
                  variant="outlined"
                />
              </Grid>
            </Grid>
            
            <Box mt={4} mb={2}>
              <Button 
                type="submit" 
                variant="contained" 
                color="primary" 
                disabled={isLoading}
                startIcon={isLoading && <CircularProgress size={20} color="inherit" />}
              >
                {isLoading ? 'Loading...' : 'Load Channels'}
              </Button>
            </Box>
          </form>
        </Paper>
      )}
    </Box>
  );
};