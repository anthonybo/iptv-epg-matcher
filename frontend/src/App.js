import React, { useEffect } from 'react';
import { AppProvider, useAppContext } from './contexts/AppContext';
import { useAppSession } from './hooks/useAppSession';
import { useAppEPG } from './hooks/useAppEPG';
import { useAppChannels } from './hooks/useAppChannels';
import { usePageTracking } from './hooks/usePageTracking';
import { AppLayout } from './components/layout/AppLayout';
import { ToastContainer } from './components/Toast';
import Configuration from './Configuration';
import ChannelsView from './components/ChannelsView';
import PlayerView from './PlayerView';
import ResultView from './ResultView';
import GuideView from './GuideView';
import IPTVEditor from './IPTVEditor';
import LiveEventsView from './LiveEventsView';
import MultiViewPage from './MultiViewPage';
import DashboardView from './DashboardView';
import EpgSourcesSummary from './components/Epg/EpgSourcesSummary';
import MyIPTVs from './pages/MyIPTVs/MyIPTVs';
import iptvSourcesService from './services/iptvSourcesService';
import apiClient from './utils/apiClient';

function AppContent() {
  const {
    sessionId,
    activeTab,
    setActiveTab,
    selectedChannel,
    setSelectedChannel,
    matchedChannels,
    setMatchedChannels,
    epgSources,
    userSources,
    setUserSources,
    selectedSourceFilter,
    setSelectedSourceFilter,
    loadingError,
    isGenerating,
    setIsGenerating,
    setStatus,
    setStatusType,
    backgroundLoadings,
    setBackgroundLoadings,
    showLoadingPicker,
    setShowLoadingPicker,
    showAddModal,
    setShowAddModal,
    isTheatreMode,
    setIsTheatreMode,
    categories,
  } = useAppContext();

  // Initialize session (CRITICAL - must be called!)
  useAppSession();

  // Track page views automatically for all tabs
  usePageTracking(activeTab);

  // Initialize hooks with side effects
  const { handleLoad, handleChannelSelect, fetchCategoriesFromApi } = useAppChannels();
  const { handleEpgMatch, handleEpgSourcesUpdated, fetchMatchedChannels } = useAppEPG();

  // Load categories and matched channels when switching to relevant tabs
  useEffect(() => {
    const now = Date.now();
    const lastCategoryFetch = window.lastCategoryFetchTime || 0;
    const lastMatchesFetch = window.lastMatchesFetchTime || 0;
    const CACHE_LIFETIME = 60000; // 1 minute
    const MATCHES_CACHE_LIFETIME = 5 * 60 * 1000; // 5 minutes - reduced API calls from every 5s to 5min

    const loadDataIfNeeded = async () => {
      if (activeTab === 'channels' && sessionId) {
        if (categories.length === 0) {
          if (now - lastCategoryFetch > CACHE_LIFETIME) {
            console.log(`[App] Loading categories for session: ${sessionId}`);
            window.lastCategoryFetchTime = now;
            await fetchCategoriesFromApi(sessionId);
          }
        }

        // Only fetch matches if cache is expired (5 minutes)
        if (now - lastMatchesFetch > MATCHES_CACHE_LIFETIME) {
          console.log('[App] Refreshing matched channels for channels view (cache expired)');
          window.lastMatchesFetchTime = now;
          await fetchMatchedChannels();
        }
      }

      if (activeTab === 'guide' && now - lastMatchesFetch > MATCHES_CACHE_LIFETIME) {
        console.log('[App] Refreshing matched channels for guide view (cache expired)');
        window.lastMatchesFetchTime = now;
        await fetchMatchedChannels();
      }

      if (activeTab === 'player' && now - lastMatchesFetch > MATCHES_CACHE_LIFETIME) {
        console.log('[App] Refreshing matched channels for player view (cache expired)');
        window.lastMatchesFetchTime = now;
        await fetchMatchedChannels();
      }
    };

    loadDataIfNeeded();
  }, [activeTab, sessionId, categories.length, fetchCategoriesFromApi, fetchMatchedChannels]);

  // Generate new XTREAM credentials
  const handleGenerate = async () => {
    setIsGenerating(true);
    setStatus('Generating new XTREAM credentials...');
    setStatusType('info');

    try {
      await apiClient.post('/generate', {
        sessionId,
        matchedChannels
      });
      setStatus('Generated new XTREAM credentials!');
      setStatusType('success');
      setActiveTab('publish');
    } catch (error) {
      setStatus(`Error: ${error.response?.data?.error || error.message}`);
      setStatusType('error');
    } finally {
      setIsGenerating(false);
    }
  };

  // Copy text to clipboard
  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text)
      .then(() => {
        setStatus('Copied to clipboard');
        setStatusType('success');
        setTimeout(() => setStatus(''), 3000);
      })
      .catch(err => {
        setStatus(`Failed to copy: ${err.message}`);
        setStatusType('error');
      });
  };

  // Render the active tab content
  const renderActiveTabContent = () => {
    switch (activeTab) {
      case 'channels':
        return (
          <ChannelsView
            sessionId={sessionId}
            onChannelSelect={handleChannelSelect}
            selectedChannel={selectedChannel}
            matchedChannels={matchedChannels}
            sourceFilter={selectedSourceFilter}
            availableSources={userSources}
            onSourceChange={(source) => setSelectedSourceFilter(source)}
          />
        );

      case 'guide':
        return (
          <GuideView
            sessionId={sessionId}
            onChannelSelect={handleChannelSelect}
          />
        );

      case 'liveevents':
        return (
          <LiveEventsView
            sessionId={sessionId}
            onNavigateToPlayer={(channel) => {
              setSelectedChannel({
                id: channel.id,
                name: channel.name,
                logo: channel.logo,
                url: channel.url,
                sourceId: channel.source_id,
                sourceType: channel.source_type,
                sourceUrl: channel.source_url,
                sourceUsername: channel.source_username,
                sourcePassword: channel.source_password,
                sourceMac: channel.source_mac,
                sourceName: channel.source_name
              });
              setActiveTab('player');
            }}
          />
        );

      case 'epg':
        return (
          <div className="space-y-6 px-6 py-8">
            <header className="space-y-2">
              <h2 className="text-3xl font-semibold text-slate-100">EPG Sources</h2>
              <p className="max-w-3xl text-sm text-slate-400">
                Review default sources from the backend and add provider-specific feeds without leaving this view.
                These sources populate guide data across the rest of the app.
              </p>
            </header>

            <div className="rounded-3xl border border-slate-800/70 bg-slate-950/70 p-6 shadow-2xl shadow-slate-950/40">
              <EpgSourcesSummary sources={epgSources} onSourcesUpdated={handleEpgSourcesUpdated} />
            </div>

            <div className="rounded-3xl border border-slate-800/70 bg-slate-950/70 p-6 shadow-2xl shadow-slate-950/40">
              <Configuration
                onLoad={handleLoad}
                error={loadingError}
                allowedTabs={['epg']}
                showFooter={false}
                showSummaryButton={false}
                heading="Add Or Refresh EPG Sources"
                description="Submit XMLTV or gzipped URLs to import or refresh guide data for this session."
              />
            </div>
          </div>
        );

      case 'player':
        if (isTheatreMode) {
          return null;
        }
        return (
          <PlayerView
            sessionId={sessionId}
            selectedChannel={selectedChannel}
            onEpgMatch={handleEpgMatch}
            matchedChannels={matchedChannels}
            availableSources={userSources}
            onBackToChannels={() => setActiveTab('channels')}
            onToggleTheatre={() => setIsTheatreMode(!isTheatreMode)}
            isTheatreMode={isTheatreMode}
          />
        );

      case 'editor':
        return (
          <IPTVEditor
            sessionId={sessionId}
            matchedChannels={matchedChannels}
            onUpdateMatches={setMatchedChannels}
            onNavigateToPlayer={(channel) => {
              setSelectedChannel({
                id: channel.iptv_channel_id,
                name: channel.name || channel.iptv_channel_name,
                logo: channel.logo,
                url: channel.url
              });
              setActiveTab('player');
            }}
          />
        );

      case 'publish':
        return (
          <ResultView
            onCopyToClipboard={copyToClipboard}
            onBackToPlayer={() => setActiveTab('player')}
            onGenerate={handleGenerate}
            isGenerating={isGenerating}
            matchedChannelsCount={Object.keys(matchedChannels).length}
          />
        );

      case 'myiptvs':
        return (
          <div className="px-6 py-8">
            <MyIPTVs
              onLoad={async (data) => {
                await handleLoad(data);
                setActiveTab('myiptvs');
              }}
              loadingError={loadingError}
              onSourcesUpdated={async () => {
                try {
                  const sources = await iptvSourcesService.getUserSources();
                  setUserSources(sources);
                } catch (err) {
                  console.error('Error reloading sources:', err);
                }
              }}
              onViewChannels={(source) => {
                setSelectedSourceFilter(source);
                setActiveTab('channels');
              }}
              backgroundLoadings={backgroundLoadings}
              setBackgroundLoadings={setBackgroundLoadings}
              showLoadingPicker={showLoadingPicker}
              setShowLoadingPicker={setShowLoadingPicker}
              showAddModal={showAddModal}
              setShowAddModal={setShowAddModal}
            />
          </div>
        );

      case 'multiview':
        return <MultiViewPage sessionId={sessionId} />;

      case 'dashboard':
        return <DashboardView />;

      default:
        setActiveTab('myiptvs');
        return null;
    }
  };

  return (
    <AppLayout
      fetchCategoriesFromApi={fetchCategoriesFromApi}
      onExitTheatre={() => setIsTheatreMode(false)}
      onEpgMatch={handleEpgMatch}
    >
      {renderActiveTabContent()}
    </AppLayout>
  );
}

function App() {
  return (
    <AppProvider>
      <AppContent />
      <ToastContainer />
    </AppProvider>
  );
}

export default App;
