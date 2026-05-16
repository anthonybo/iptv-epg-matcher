import React, { createContext, useContext, useState } from 'react';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  // Session state
  const [sessionId, setSessionId] = useState(null);
  const [initialized, setInitialized] = useState(false);

  // Channel state
  const [channels, setChannels] = useState([]);
  const [totalChannels, setTotalChannels] = useState(0);
  const [categories, setCategories] = useState([]);
  const [hiddenCategories, setHiddenCategories] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [selectedChannel, setSelectedChannel] = useState(null);
  const [selectedSourceFilter, setSelectedSourceFilter] = useState(null);

  // EPG state
  const [epgSources, setEpgSources] = useState([]);
  const [matchedChannels, setMatchedChannels] = useState({});
  const [totalMatches, setTotalMatches] = useState(0);

  // User sources state
  const [userSources, setUserSources] = useState([]);
  const [loadingSources, setLoadingSources] = useState(false);

  // UI state
  const [activeTab, setActiveTab] = useState('myiptvs');
  const [showSidebar, setShowSidebar] = useState(true);
  const [status, setStatus] = useState('');
  const [statusType, setStatusType] = useState('info');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingError, setLoadingError] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isTheatreMode, setIsTheatreMode] = useState(false);

  // Modal state
  const [sessionDebuggerOpen, setSessionDebuggerOpen] = useState(false);
  const [showServerStatus, setShowServerStatus] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);

  // Background loading state
  const [backgroundLoadings, setBackgroundLoadings] = useState(new Map());
  const [showLoadingPicker, setShowLoadingPicker] = useState(false);

  // Source-list revision counter. Bumped any time a source is added,
  // updated, or removed. Consumers (MyIPTVs page, App.js userSources)
  // watch this and refetch when it changes. This decouples the
  // global Add-IPTV-Source modal (which lives in AppLayout, persists
  // across page navigation) from the page that consumes the source
  // list. Without this, navigating away from MyIPTVs mid-bulk-add
  // unmounted the entire modal including BulkAddSources and dropped
  // every queued source.
  const [sourceListRevision, setSourceListRevision] = useState(0);
  const bumpSourceListRevision = () => setSourceListRevision((n) => n + 1);

  // Result state
  const [result, setResult] = useState(null);
  const [showEmergencyCategories, setShowEmergencyCategories] = useState(true);

  const value = {
    // Session
    sessionId,
    setSessionId,
    initialized,
    setInitialized,

    // Channels
    channels,
    setChannels,
    totalChannels,
    setTotalChannels,
    categories,
    setCategories,
    hiddenCategories,
    setHiddenCategories,
    selectedCategory,
    setSelectedCategory,
    selectedChannel,
    setSelectedChannel,
    selectedSourceFilter,
    setSelectedSourceFilter,

    // EPG
    epgSources,
    setEpgSources,
    matchedChannels,
    setMatchedChannels,
    totalMatches,
    setTotalMatches,

    // User sources
    userSources,
    setUserSources,
    loadingSources,
    setLoadingSources,

    // UI
    activeTab,
    setActiveTab,
    showSidebar,
    setShowSidebar,
    status,
    setStatus,
    statusType,
    setStatusType,
    isLoading,
    setIsLoading,
    loadingError,
    setLoadingError,
    isGenerating,
    setIsGenerating,
    isTheatreMode,
    setIsTheatreMode,

    // Modals
    sessionDebuggerOpen,
    setSessionDebuggerOpen,
    showServerStatus,
    setShowServerStatus,
    showAddModal,
    setShowAddModal,

    // Background loading
    backgroundLoadings,
    setBackgroundLoadings,
    showLoadingPicker,
    setShowLoadingPicker,

    // Source-list revision (bumped when sources are added/changed)
    sourceListRevision,
    bumpSourceListRevision,

    // Result
    result,
    setResult,
    showEmergencyCategories,
    setShowEmergencyCategories,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppContext() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
}
