import React, { useState, useEffect } from 'react';
import apiClient from './utils/apiClient';
import IPTVPlayer from './IPTVPlayer';

const IPTVEditor = ({ matchedChannels, onUpdateMatches, onNavigateToPlayer, sessionId }) => {
  const [channels, setChannels] = useState([]);
  const [categories, setCategories] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [editingChannel, setEditingChannel] = useState(null);
  const [editingCategory, setEditingCategory] = useState(null);
  const [selectedChannelDetail, setSelectedChannelDetail] = useState(null);
  const [channelEpgData, setChannelEpgData] = useState([]);
  const [loadingEpg, setLoadingEpg] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [viewMode, setViewMode] = useState('channels'); // 'channels', 'categories', 'epg'
  const [loading, setLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [publishResult, setPublishResult] = useState(null);
  const [channelToRemove, setChannelToRemove] = useState(null);
  const [sources, setSources] = useState([]);
  const [globalAutoDetect, setGlobalAutoDetect] = useState(false);
  const [refreshingLiveEvents, setRefreshingLiveEvents] = useState(false);

  // Load matched channels and sources from database
  useEffect(() => {
    loadMatchedChannels();
    loadSources();
  }, []);

  const loadSources = async () => {
    try {
      const response = await apiClient.get('/iptv/sources');
      if (response.data && Array.isArray(response.data.sources)) {
        setSources(response.data.sources);
        // Set global auto-detect if any source has it enabled
        setGlobalAutoDetect(response.data.sources.some(s => s.auto_detect_live === 1));
      }
    } catch (error) {
      console.error('Failed to load sources:', error);
    }
  };

  const loadMatchedChannels = async () => {
    try {
      setLoading(true);
      const response = await apiClient.get('/epg/matched-channels');

      if (response.data && Array.isArray(response.data.channels)) {
        setChannels(response.data.channels);

        // Extract unique categories
        const categoryMap = new Map();
        response.data.channels.forEach(ch => {
          const category = ch.group_title || 'Uncategorized';
          if (!categoryMap.has(category)) {
            categoryMap.set(category, {
              name: category,
              channelCount: 0
            });
          }
          categoryMap.get(category).channelCount++;
        });

        setCategories(Array.from(categoryMap.values()));
      }
    } catch (error) {
      console.error('Failed to load matched channels:', error);
    } finally {
      setLoading(false);
    }
  };

  const filteredChannels = channels.filter(ch => {
    const matchesSearch = !searchTerm ||
      ch.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      ch.epg_channel_name?.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesCategory = !selectedCategory ||
      (ch.group_title || 'Uncategorized') === selectedCategory;

    return matchesSearch && matchesCategory;
  });

  const handleSaveChannel = async (channel) => {
    try {
      // TODO: Implement API endpoint to update channel metadata
      await apiClient.put(`/epg/matched-channels/${channel.iptv_channel_id}`, {
        name: channel.name,
        logo: channel.logo,
        group_title: channel.group_title
      });

      // Update local state
      setChannels(prev => prev.map(ch =>
        ch.iptv_channel_id === channel.iptv_channel_id ? channel : ch
      ));

      setEditingChannel(null);
      loadMatchedChannels(); // Refresh to update categories
    } catch (error) {
      console.error('Failed to save channel:', error);
    }
  };

  const handleRemoveChannel = async () => {
    if (!channelToRemove) return;

    try {
      await apiClient.delete(`/epg/matched-channels/${channelToRemove.match_id}`);
      setChannels(prev => prev.filter(ch => ch.match_id !== channelToRemove.match_id));
      setChannelToRemove(null);
      loadMatchedChannels(); // Refresh categories
    } catch (error) {
      console.error('Failed to remove channel:', error);
      setChannelToRemove(null);
    }
  };

  const handleToggleDummyEpg = async (matchId, useDummyEpg) => {
    try {
      await apiClient.put(`/epg/matched-channels/${matchId}/dummy-epg`, {
        useDummyEpg
      });

      // Update local state
      setChannels(prev => prev.map(ch =>
        ch.match_id === matchId ? { ...ch, use_dummy_epg: useDummyEpg ? 1 : 0 } : ch
      ));
    } catch (error) {
      console.error('Failed to toggle dummy EPG:', error);
    }
  };

  const handleToggleLivePrefix = async (channelId, enableLivePrefix) => {
    try {
      await apiClient.patch(`/iptv/channels/${channelId}/live-prefix`, {
        enableLivePrefix
      });

      // Update local state
      setChannels(prev => prev.map(ch =>
        ch.iptv_channel_id === channelId ? { ...ch, enable_live_prefix: enableLivePrefix ? 1 : 0 } : ch
      ));
    } catch (error) {
      console.error('Failed to toggle live prefix:', error);
    }
  };

  const handleToggleGlobalAutoDetect = async (enabled) => {
    try {
      // Update all sources
      const updatePromises = sources.map(source =>
        apiClient.patch(`/iptv/sources/${source.id}/auto-detect-live`, {
          autoDetectLive: enabled
        })
      );

      await Promise.all(updatePromises);

      // Update local state
      setGlobalAutoDetect(enabled);
      setSources(prev => prev.map(s => ({ ...s, auto_detect_live: enabled ? 1 : 0 })));
      setChannels(prev => prev.map(ch => ({ ...ch, sourceAutoDetectLive: enabled ? 1 : 0 })));
    } catch (error) {
      console.error('Failed to toggle global auto-detect:', error);
    }
  };

  const handleRenameCategory = async (oldName, newName) => {
    try {
      // Update all channels in this category
      const updatedChannels = channels.map(ch =>
        (ch.group_title || 'Uncategorized') === oldName
          ? { ...ch, group_title: newName }
          : ch
      );

      // TODO: Implement batch update API endpoint
      await apiClient.post('/epg/matched-channels/batch-update-category', {
        oldCategory: oldName,
        newCategory: newName
      });

      setChannels(updatedChannels);
      setEditingCategory(null);
      loadMatchedChannels();
    } catch (error) {
      console.error('Failed to rename category:', error);
    }
  };

  const handleChannelClick = async (channel) => {
    setSelectedChannelDetail(channel);
    setLoadingEpg(true);

    try {
      // Check if this is a dummy EPG channel (either no epg_channel_id or starts with "dummy_")
      const isDummyChannel = channel.use_dummy_epg === 1 ||
                            !channel.epg_channel_id ||
                            (channel.epg_channel_id && channel.epg_channel_id.startsWith('dummy_'));

      if (isDummyChannel) {
        // Generate dummy EPG data on the frontend
        const dummyPrograms = [];
        const now = new Date();

        // Generate 7 days of 3-hour blocks
        for (let day = 0; day < 7; day++) {
          for (let hour = 0; hour < 24; hour += 3) {
            const startDate = new Date(now);
            startDate.setDate(startDate.getDate() + day);
            startDate.setHours(hour, 0, 0, 0);

            const stopDate = new Date(startDate);
            stopDate.setHours(stopDate.getHours() + 3);

            // Format as XMLTV timestamp: YYYYMMDDHHMMSS +TZTZ
            const formatXmltvTime = (date) => {
              const pad = (n) => String(n).padStart(2, '0');
              const year = date.getFullYear();
              const month = pad(date.getMonth() + 1);
              const dayNum = pad(date.getDate());
              const hours = pad(date.getHours());
              const minutes = pad(date.getMinutes());
              const seconds = pad(date.getSeconds());
              return `${year}${month}${dayNum}${hours}${minutes}${seconds} +0000`;
            };

            dummyPrograms.push({
              channel_id: channel.epg_channel_id || `dummy_${channel.iptv_channel_id}`,
              title: channel.name || channel.iptv_channel_name,
              start: formatXmltvTime(startDate),
              stop: formatXmltvTime(stopDate),
              description: `Streaming on ${channel.name || channel.iptv_channel_name}`,
              category: channel.group_title || 'Live TV'
            });
          }
        }

        setChannelEpgData(dummyPrograms);
      } else if (channel.epg_channel_id) {
        // Fetch real EPG data for channels with EPG match
        const response = await apiClient.get(`/epg/channel-programs/${channel.epg_channel_id}`);
        setChannelEpgData(response.data.programs || []);
      } else {
        // No EPG data available
        setChannelEpgData([]);
      }
    } catch (error) {
      console.error('Failed to load EPG data:', error);
      setChannelEpgData([]);
    } finally {
      setLoadingEpg(false);
    }
  };

  const handleCloseDetail = () => {
    setSelectedChannelDetail(null);
    setChannelEpgData([]);
  };

  const handlePublishUpdates = async () => {
    setPublishing(true);
    setShowPublishModal(false);

    try {
      // Call the update endpoint to regenerate all credentials
      const response = await apiClient.post('/generate/update-all');

      if (response.data.success) {
        if (response.data.updatedCount === 0) {
          setPublishResult({
            success: false,
            message: 'No existing credentials to update. Please create credentials from the Credentials tab first.'
          });
        } else {
          setPublishResult({
            success: true,
            message: `Successfully updated ${response.data.updatedCount} credential(s) with ${response.data.channelCount} channels!`
          });
        }
      }
    } catch (error) {
      console.error('Failed to publish updates:', error);
      setPublishResult({
        success: false,
        message: error.response?.data?.error || error.message
      });
    } finally {
      setPublishing(false);
    }
  };

  const handleRefreshLiveEvents = async () => {
    try {
      setRefreshingLiveEvents(true);
      const response = await apiClient.post('/live-events/refresh');

      if (response.data.success) {
        console.log(`Refreshed ${response.data.totalFetched} events, stored ${response.data.totalStored}`);
        // Optionally show success message to user
      }
    } catch (error) {
      console.error('Failed to refresh live events:', error);
    } finally {
      setRefreshingLiveEvents(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-slate-950">
      {/* Header */}
      <div className="border-b border-slate-800 bg-slate-950/50 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-100">IPTV Editor</h1>
            <p className="mt-1 text-sm text-slate-400">
              Customize channels, categories, and EPG data before publishing
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-blue-500/20 px-3 py-1 text-sm font-semibold text-blue-300">
              {channels.length} channels
            </span>
            <span className="rounded-full bg-purple-500/20 px-3 py-1 text-sm font-semibold text-purple-300">
              {categories.length} categories
            </span>
            <button
              onClick={handleRefreshLiveEvents}
              disabled={refreshingLiveEvents}
              className="flex items-center gap-2 rounded-xl bg-blue-500/20 px-4 py-2.5 text-sm font-medium text-blue-300 transition-all hover:bg-blue-500/30 disabled:opacity-50"
            >
              <svg
                className={`h-4 w-4 ${refreshingLiveEvents ? 'animate-spin' : ''}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0118.8-4.3M22 12.5a10 10 0 01-18.8 4.2" />
              </svg>
              {refreshingLiveEvents ? 'Refreshing...' : 'Refresh Live Events'}
            </button>
            <button
              onClick={() => setShowPublishModal(true)}
              disabled={publishing || channels.length === 0}
              className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 font-semibold text-white transition hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {publishing ? (
                <>
                  <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Publishing...
                </>
              ) : (
                <>
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Publish Updates
                </>
              )}
            </button>
          </div>
        </div>

        {/* View Mode Tabs */}
        <div className="mt-4 flex gap-2">
          <button
            onClick={() => setViewMode('channels')}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
              viewMode === 'channels'
                ? 'bg-blue-500/20 text-blue-300'
                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            Channels
          </button>
          <button
            onClick={() => setViewMode('categories')}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
              viewMode === 'categories'
                ? 'bg-blue-500/20 text-blue-300'
                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            Categories
          </button>
          <button
            onClick={() => setViewMode('epg')}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
              viewMode === 'epg'
                ? 'bg-blue-500/20 text-blue-300'
                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            EPG Data
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar - Categories */}
        <div className="w-64 border-r border-slate-800 bg-slate-950/30">
          <div className="p-4">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-500">
              Categories
            </h3>
            <button
              onClick={() => setSelectedCategory(null)}
              className={`mb-2 w-full rounded-lg px-3 py-2 text-left text-sm transition ${
                !selectedCategory
                  ? 'bg-blue-500/20 text-blue-300'
                  : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              <div className="flex items-center justify-between">
                <span>All Channels</span>
                <span className="text-xs text-slate-500">{channels.length}</span>
              </div>
            </button>

            <div className="space-y-1">
              {categories.map((cat) => (
                <button
                  key={cat.name}
                  onClick={() => setSelectedCategory(cat.name)}
                  className={`w-full rounded-lg px-3 py-2 text-left text-sm transition ${
                    selectedCategory === cat.name
                      ? 'bg-blue-500/20 text-blue-300'
                      : 'text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="truncate">{cat.name}</span>
                    <span className="text-xs text-slate-500">{cat.channelCount}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Main Content */}
        <div className="flex-1 overflow-y-auto">
          {viewMode === 'channels' && (
            <div className="p-6">
              {/* Global Auto-Detect LIVE Toggle */}
              <div className="mb-6 rounded-lg border border-slate-700 bg-slate-900/50 p-4">
                <label className="flex items-center justify-between cursor-pointer">
                  <div className="flex-1">
                    <div className="font-semibold text-slate-200">Auto-Detect LIVE for all channels</div>
                    <p className="mt-1 text-xs text-slate-400">
                      Automatically add "LIVE:" prefix to currently airing programs across all channels
                    </p>
                  </div>
                  <div className="relative ml-4">
                    <input
                      type="checkbox"
                      checked={globalAutoDetect}
                      onChange={(e) => handleToggleGlobalAutoDetect(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-slate-700 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                  </div>
                </label>
              </div>

              {/* Search */}
              <div className="mb-6">
                <input
                  type="text"
                  placeholder="Search channels..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-slate-200 placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                />
              </div>

              {/* Channel List */}
              <div className="space-y-3">
                {loading ? (
                  <div className="py-12 text-center text-slate-400">Loading channels...</div>
                ) : filteredChannels.length === 0 ? (
                  <div className="py-12 text-center text-slate-400">
                    {searchTerm ? 'No channels match your search' : 'No matched channels yet'}
                  </div>
                ) : (
                  filteredChannels.map((channel) => (
                    <ChannelCard
                      key={`${channel.match_id}-${channel.iptv_channel_id}-${channel.source_name}-${channel.epg_source_name}`}
                      channel={channel}
                      isEditing={editingChannel?.match_id === channel.match_id}
                      onEdit={() => setEditingChannel(channel)}
                      onSave={handleSaveChannel}
                      onCancel={() => setEditingChannel(null)}
                      onRemove={() => setChannelToRemove(channel)}
                      onClick={() => handleChannelClick(channel)}
                      onToggleDummyEpg={handleToggleDummyEpg}
                      onToggleLivePrefix={handleToggleLivePrefix}
                    />
                  ))
                )}
              </div>
            </div>
          )}

          {viewMode === 'categories' && (
            <div className="p-6">
              <CategoryManager
                categories={categories}
                channels={channels}
                onRenameCategory={handleRenameCategory}
              />
            </div>
          )}

          {viewMode === 'epg' && (
            <div className="p-6">
              <div className="py-12 text-center text-slate-400">
                EPG Editor coming soon...
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Channel Detail Drawer */}
      {selectedChannelDetail && (
        <ChannelDetailDrawer
          channel={selectedChannelDetail}
          epgData={channelEpgData}
          loadingEpg={loadingEpg}
          sessionId={sessionId}
          onClose={handleCloseDetail}
          onNavigateToPlayer={() => {
            onNavigateToPlayer?.(selectedChannelDetail);
            handleCloseDetail();
          }}
        />
      )}

      {/* Publish Confirmation Modal */}
      {showPublishModal && (
        <Modal
          title="Publish Updates"
          onClose={() => setShowPublishModal(false)}
        >
          <div className="space-y-4">
            <p className="text-slate-300">
              This will update all your existing IPTV credentials with the current channel list ({channels.length} channels).
            </p>
            <p className="text-sm text-slate-400">
              All devices using these credentials will automatically receive the updated channel list.
            </p>
            <div className="flex gap-3">
              <button
                onClick={handlePublishUpdates}
                className="flex-1 rounded-lg bg-green-600 px-4 py-2.5 font-semibold text-white transition hover:bg-green-500"
              >
                Confirm & Publish
              </button>
              <button
                onClick={() => setShowPublishModal(false)}
                className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2.5 font-semibold text-slate-300 transition hover:bg-slate-700"
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Publish Result Modal */}
      {publishResult && (
        <Modal
          title={publishResult.success ? 'Success!' : 'Error'}
          onClose={() => setPublishResult(null)}
        >
          <div className="space-y-4">
            <div className={`flex items-start gap-3 rounded-lg p-4 ${
              publishResult.success ? 'bg-green-900/20 border border-green-700' : 'bg-rose-900/20 border border-rose-700'
            }`}>
              {publishResult.success ? (
                <svg className="h-6 w-6 flex-shrink-0 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ) : (
                <svg className="h-6 w-6 flex-shrink-0 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              )}
              <div className="flex-1">
                <p className={publishResult.success ? 'text-green-100' : 'text-rose-100'}>
                  {publishResult.message}
                </p>
              </div>
            </div>
            <button
              onClick={() => setPublishResult(null)}
              className="w-full rounded-lg bg-blue-600 px-4 py-2.5 font-semibold text-white transition hover:bg-blue-500"
            >
              Close
            </button>
          </div>
        </Modal>
      )}

      {/* Remove Channel Confirmation Modal */}
      {channelToRemove && (
        <Modal
          title="Remove Channel"
          onClose={() => setChannelToRemove(null)}
        >
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-lg border border-rose-700 bg-rose-900/20 p-4">
              <svg className="h-6 w-6 flex-shrink-0 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div className="flex-1">
                <p className="font-medium text-rose-100">
                  Are you sure you want to remove this channel?
                </p>
                <p className="mt-2 text-sm text-rose-200">
                  <span className="font-semibold">{channelToRemove.name || channelToRemove.iptv_channel_name}</span>
                </p>
                <p className="mt-1 text-xs text-rose-300">
                  This will remove it from your IPTV Editor. You can always add it back later.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleRemoveChannel}
                className="flex-1 rounded-lg border border-rose-700 bg-rose-600 px-4 py-2.5 font-semibold text-white transition hover:bg-rose-500"
              >
                Remove Channel
              </button>
              <button
                onClick={() => setChannelToRemove(null)}
                className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2.5 font-semibold text-slate-300 transition hover:bg-slate-700"
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

const ChannelCard = ({ channel, isEditing, onEdit, onSave, onCancel, onRemove, onClick, onToggleDummyEpg, onToggleLivePrefix }) => {
  const [editedChannel, setEditedChannel] = useState(channel);

  useEffect(() => {
    setEditedChannel(channel);
  }, [channel]);

  const handleCardClick = (e) => {
    // Don't trigger if clicking on action buttons
    if (!e.target.closest('button')) {
      onClick?.();
    }
  };

  if (isEditing) {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-400">Channel Name</label>
            <input
              type="text"
              value={editedChannel.name || ''}
              onChange={(e) => setEditedChannel({ ...editedChannel, name: e.target.value })}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-400">Logo URL</label>
            <input
              type="text"
              value={editedChannel.logo || ''}
              onChange={(e) => setEditedChannel({ ...editedChannel, logo: e.target.value })}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-400">Category</label>
            <input
              type="text"
              value={editedChannel.group_title || ''}
              onChange={(e) => setEditedChannel({ ...editedChannel, group_title: e.target.value })}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => onSave(editedChannel)}
              className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500"
            >
              Save
            </button>
            <button
              onClick={onCancel}
              className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-300 transition hover:bg-slate-700"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={handleCardClick}
      className="flex items-center gap-4 rounded-xl border border-slate-800 bg-slate-900/50 p-4 transition hover:border-slate-700 hover:bg-slate-900 cursor-pointer"
    >
      {/* Logo */}
      <div className="h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg bg-slate-800">
        {channel.logo ? (
          <img src={channel.logo} alt={channel.name} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-600">
            <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <rect x="2" y="3" width="20" height="14" rx="2" strokeWidth="2" />
            </svg>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1">
        <h4 className="font-semibold text-slate-200">{channel.name || channel.iptv_channel_name}</h4>
        <div className="mt-1 flex flex-col gap-1 text-xs text-slate-500">
          <div className="flex items-center gap-2">
            <span className="rounded bg-slate-800 px-2 py-0.5">{channel.group_title || 'Uncategorized'}</span>
            {channel.source_name && (
              <span className="rounded bg-purple-900/30 px-2 py-0.5 text-purple-300">
                IPTV: {channel.source_name}
              </span>
            )}
          </div>
          {channel.epg_channel_name && (
            <div className="flex items-center gap-1">
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              <span>EPG: {channel.epg_channel_name}</span>
              {channel.epg_source_name && (
                <span className="rounded bg-blue-900/30 px-2 py-0.5 text-blue-300">
                  {channel.epg_source_name}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <button
            onClick={onEdit}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-300 transition hover:bg-slate-700"
          >
            Edit
          </button>
          <button
            onClick={onRemove}
            className="rounded-lg border border-rose-700 bg-rose-900/50 px-3 py-2 text-sm font-semibold text-rose-300 transition hover:bg-rose-900"
          >
            Remove
          </button>
        </div>
        <label
          className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer hover:text-slate-300 transition"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={channel.use_dummy_epg === 1}
            onChange={(e) => {
              e.stopPropagation();
              if (onToggleDummyEpg) {
                onToggleDummyEpg(channel.match_id, e.target.checked);
              }
            }}
            className="rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-2 focus:ring-blue-500 focus:ring-offset-slate-900"
          />
          <span title="Generate dummy EPG for channels with dynamic names">Dummy EPG</span>
        </label>
        <label
          className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer hover:text-slate-300 transition"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={channel.enable_live_prefix === 1}
            onChange={(e) => {
              e.stopPropagation();
              if (onToggleLivePrefix) {
                onToggleLivePrefix(channel.iptv_channel_id, e.target.checked);
              }
            }}
            className="rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-2 focus:ring-blue-500 focus:ring-offset-slate-900"
          />
          <span title="Add 'LIVE:' prefix to currently airing programs">LIVE prefix</span>
        </label>
      </div>
    </div>
  );
};

const CategoryManager = ({ categories, channels, onRenameCategory }) => {
  const [editingCategory, setEditingCategory] = useState(null);
  const [newName, setNewName] = useState('');

  const handleStartEdit = (category) => {
    setEditingCategory(category.name);
    setNewName(category.name);
  };

  const handleSave = () => {
    if (newName && newName !== editingCategory) {
      onRenameCategory(editingCategory, newName);
    }
    setEditingCategory(null);
    setNewName('');
  };

  return (
    <div className="space-y-4">
      <div className="mb-6">
        <h2 className="text-xl font-bold text-slate-100">Category Management</h2>
        <p className="mt-1 text-sm text-slate-400">
          Organize and rename your channel categories
        </p>
      </div>

      <div className="grid gap-4">
        {categories.map((category) => (
          <div
            key={category.name}
            className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"
          >
            {editingCategory === category.name ? (
              <div className="space-y-3">
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-200 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                  autoFocus
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleSave}
                    className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditingCategory(null)}
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-300 transition hover:bg-slate-700"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-slate-200">{category.name}</h3>
                  <p className="mt-1 text-sm text-slate-500">{category.channelCount} channels</p>
                </div>
                <button
                  onClick={() => handleStartEdit(category)}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-300 transition hover:bg-slate-700"
                >
                  Rename
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

const ChannelDetailDrawer = ({ channel, epgData, loadingEpg, sessionId, onClose, onNavigateToPlayer }) => {
  const [showPip, setShowPip] = useState(false);

  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    // timestamp format: YYYYMMDDHHmmss
    const year = timestamp.substring(0, 4);
    const month = timestamp.substring(4, 6);
    const day = timestamp.substring(6, 8);
    const hour = timestamp.substring(8, 10);
    const minute = timestamp.substring(10, 12);

    return `${month}/${day} ${hour}:${minute}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="relative h-full w-full max-w-2xl overflow-y-auto border-l border-slate-800 bg-slate-950 shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/95 backdrop-blur">
          <div className="flex items-center justify-between p-6">
            <div className="flex items-center gap-4">
              {channel.logo && (
                <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg bg-slate-800">
                  <img src={channel.logo} alt={channel.name} className="h-full w-full object-cover" />
                </div>
              )}
              <div>
                <h2 className="text-2xl font-bold text-slate-100">{channel.name || channel.iptv_channel_name}</h2>
                <div className="mt-1 flex items-center gap-2 text-sm text-slate-400">
                  <span className="rounded bg-slate-800 px-2 py-0.5">{channel.group_title || 'Uncategorized'}</span>
                  {channel.source_name && (
                    <span className="rounded bg-purple-900/30 px-2 py-0.5 text-purple-300">
                      {channel.source_name}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <button
              onClick={onClose}
              className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
            >
              <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-3 px-6 pb-4">
            <button
              onClick={() => setShowPip(!showPip)}
              className={`flex flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-3 font-semibold transition ${
                showPip
                  ? 'border-blue-700 bg-blue-600 text-white hover:bg-blue-500'
                  : 'border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700'
              }`}
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" strokeWidth="2" />
                <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" />
              </svg>
              {showPip ? 'Hide Stream' : 'Test Stream'}
            </button>
            <button
              onClick={onNavigateToPlayer}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-4 py-3 font-semibold text-slate-200 transition hover:bg-slate-700"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              Edit EPG Match
            </button>
          </div>

          {/* PIP Player */}
          {showPip && (
            <div className="border-t border-slate-800 bg-slate-900/50 px-6 py-4">
              <div className="rounded-lg" style={{ minHeight: '400px' }}>
                <IPTVPlayer
                  sessionId={sessionId}
                  selectedChannel={{
                    id: channel.iptv_channel_id,
                    name: channel.name || channel.iptv_channel_name,
                    logo: channel.logo,
                    url: channel.url
                  }}
                  playbackMethod="mpegts-player"
                  matchedChannels={{}}
                  theatreMode={false}
                />
              </div>
            </div>
          )}
        </div>

        {/* EPG Programs */}
        <div className="p-6">
          <h3 className="mb-4 text-lg font-bold text-slate-100">Program Guide</h3>

          {loadingEpg ? (
            <div className="py-12 text-center text-slate-400">Loading EPG data...</div>
          ) : epgData.length === 0 ? (
            <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-8 text-center text-slate-400">
              <svg className="mx-auto h-12 w-12 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p className="mt-3">No EPG data available for this channel</p>
              <p className="mt-1 text-sm">Try changing the EPG match to get program information</p>
            </div>
          ) : (
            <div className="space-y-2">
              {epgData.map((program, index) => {
                const now = new Date();
                const startTime = new Date(
                  program.start.substring(0, 4),
                  parseInt(program.start.substring(4, 6)) - 1,
                  program.start.substring(6, 8),
                  program.start.substring(8, 10),
                  program.start.substring(10, 12)
                );
                const stopTime = new Date(
                  program.stop.substring(0, 4),
                  parseInt(program.stop.substring(4, 6)) - 1,
                  program.stop.substring(6, 8),
                  program.stop.substring(8, 10),
                  program.stop.substring(10, 12)
                );
                const isCurrentProgram = now >= startTime && now <= stopTime;

                return (
                  <div
                    key={`${program.start}-${index}`}
                    className={`rounded-lg border p-4 transition ${
                      isCurrentProgram
                        ? 'border-blue-700 bg-blue-900/20'
                        : 'border-slate-800 bg-slate-900/50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          {isCurrentProgram && (
                            <span className="flex items-center gap-1 rounded bg-blue-600 px-2 py-0.5 text-xs font-semibold text-white">
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                              LIVE NOW
                            </span>
                          )}
                          <h4 className="font-semibold text-slate-100">{program.title}</h4>
                        </div>
                        {program.description && (
                          <p className="mt-2 text-sm text-slate-400">{program.description}</p>
                        )}
                        {program.category && (
                          <span className="mt-2 inline-block rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
                            {program.category}
                          </span>
                        )}
                      </div>
                      <div className="flex-shrink-0 text-right text-sm text-slate-400">
                        <div>{formatTime(program.start)}</div>
                        <div className="text-slate-600">to</div>
                        <div>{formatTime(program.stop)}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const Modal = ({ title, children, onClose }) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-md rounded-xl border border-slate-800 bg-slate-950 p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-xl font-bold text-slate-100">{title}</h3>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
};

export default IPTVEditor;
