import React from 'react';
import { 
  Box, 
  Typography, 
  LinearProgress, 
  Paper, 
  List, 
  ListItem, 
  ListItemIcon, 
  ListItemText,
  Chip,
  Divider
} from '@mui/material';
import DoneIcon from '@mui/icons-material/Done';
import ErrorIcon from '@mui/icons-material/Error';
import PendingIcon from '@mui/icons-material/Pending';
import CachedIcon from '@mui/icons-material/Cached';
import PlaylistPlayIcon from '@mui/icons-material/PlaylistPlay';
import LiveTvIcon from '@mui/icons-material/LiveTv';

const ProgressIndicator = ({ progressData }) => {
  const { progress, stage, message, detail } = progressData || {};
  
  // Map stages to more user-friendly labels
  const stageLabels = {
    'init': 'Initializing',
    'cache_check': 'Checking Cache',
    'loading_channels': 'Loading Channels',
    'channels_loaded': 'Channels Loaded',
    'loading_epg': 'Loading Program Guide',
    'loading_epg_source': 'Loading EPG Source',
    'epg_loaded': 'Program Guide Loaded',
    'finalizing': 'Finalizing',
    'complete': 'Complete',
    'error': 'Error'
  };
  
  // Map stages to icons
  const stageIcons = {
    'init': <PendingIcon />,
    'cache_check': <CachedIcon />,
    'loading_channels': <LiveTvIcon />,
    'channels_loaded': <DoneIcon color="success" />,
    'loading_epg': <PlaylistPlayIcon />,
    'loading_epg_source': <PlaylistPlayIcon />,
    'epg_loaded': <DoneIcon color="success" />,
    'finalizing': <PendingIcon />,
    'complete': <DoneIcon color="success" />,
    'error': <ErrorIcon color="error" />
  };
  
  // Get stage history based on current stage
  const getStageHistory = () => {
    const allStages = [
      'init', 
      'cache_check', 
      'loading_channels', 
      'channels_loaded',
      'loading_epg',
      'loading_epg_source',
      'epg_loaded',
      'finalizing',
      'complete'
    ];
    
    const currentIndex = allStages.indexOf(stage);
    if (currentIndex === -1) return allStages.map(s => ({ 
      stage: s, 
      status: 'pending',
      label: stageLabels[s] || s
    }));
    
    return allStages.map((s, index) => {
      let status = 'pending';
      if (index < currentIndex) status = 'completed';
      else if (index === currentIndex) status = 'active';
      
      return {
        stage: s,
        status,
        label: stageLabels[s] || s
      };
    });
  };
  
  return (
    <Paper elevation={2} sx={{ p: 3, maxWidth: 800, mx: 'auto', mb: 3 }}>
      <Typography variant="h6" gutterBottom>
        Loading Data
      </Typography>
      
      <Box sx={{ mb: 2 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="body2" color="text.secondary">
            {message || 'Processing...'}
          </Typography>
          <Typography variant="body2" fontWeight="bold">
            {Math.round(progress || 0)}%
          </Typography>
        </Box>
        
        <LinearProgress 
          variant="determinate" 
          value={progress || 0} 
          sx={{ height: 10, borderRadius: 5 }}
        />
        
        {detail && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
            {detail}
          </Typography>
        )}
      </Box>
      
      <Divider sx={{ my: 2 }} />
      
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Processing Steps:
      </Typography>
      
      <List dense sx={{ bgcolor: 'background.paper' }}>
        {getStageHistory().map((item) => (
          <ListItem key={item.stage} sx={{ 
            py: 0.5,
            opacity: item.status === 'pending' ? 0.5 : 1,
          }}>
            <ListItemIcon sx={{ minWidth: 36 }}>
              {item.status === 'active' 
                ? stageIcons[item.stage] 
                : item.status === 'completed' 
                  ? <DoneIcon color="success" />
                  : <PendingIcon color="disabled" fontSize="small" />
              }
            </ListItemIcon>
            <ListItemText 
              primary={item.label} 
              primaryTypographyProps={{ 
                fontWeight: item.status === 'active' ? 'bold' : 'normal',
                variant: 'body2'
              }}
            />
            {item.status === 'active' && (
              <Chip 
                label="In Progress" 
                size="small" 
                color="primary" 
                variant="outlined"
              />
            )}
          </ListItem>
        ))}
      </List>
    </Paper>
  );
};

export default ProgressIndicator;