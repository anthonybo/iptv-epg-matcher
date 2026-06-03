import React, { useState, useEffect } from 'react';
import { useMetrics } from './hooks/useMetrics';
import { useAuth } from './contexts/AuthContext';
import BandwidthChart from './components/Dashboard/BandwidthChart';
import StreamsChart from './components/Dashboard/StreamsChart';
import RequestsChart from './components/Dashboard/RequestsChart';
import MemoryChart from './components/Dashboard/MemoryChart';
import StreamTypeChart from './components/Dashboard/StreamTypeChart';
import ActiveSessionsPanel from './components/Dashboard/ActiveSessionsPanel';
import PageActivityPanel from './components/Dashboard/PageActivityPanel';
import CommercialDetectionPanel from './components/Dashboard/CommercialDetectionPanel';
import AiMatchingPanel from './components/Dashboard/AiMatchingPanel';

/**
 * MetricCard - Displays a single metric value
 */
const MetricCard = ({ title, value, subtitle, icon, color = 'blue' }) => {
  const colorClasses = {
    blue: 'bg-blue-500/10 border-blue-500/40 text-blue-300',
    green: 'bg-green-500/10 border-green-500/40 text-green-300',
    purple: 'bg-purple-500/10 border-purple-500/40 text-purple-300',
    orange: 'bg-orange-500/10 border-orange-500/40 text-orange-300',
    red: 'bg-red-500/10 border-red-500/40 text-red-300'
  };

  return (
    <div className={`rounded-xl border ${colorClasses[color]} p-6`}>
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <div className="text-sm font-medium text-slate-400">{title}</div>
          <div className="mt-2 text-3xl font-bold">{value}</div>
          {subtitle && <div className="mt-1 text-xs text-slate-500">{subtitle}</div>}
        </div>
        {icon && <div className="text-4xl opacity-50">{icon}</div>}
      </div>
    </div>
  );
};

/**
 * ActiveStreamsTable - Shows list of currently active streams
 */
const ActiveStreamsTable = ({ streams }) => {
  if (!streams || streams.length === 0) {
    return (
      <div className="text-center py-8 text-slate-500">
        No active streams
      </div>
    );
  }

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-800 text-left">
            <th className="pb-3 font-semibold text-slate-300">Channel</th>
            <th className="pb-3 font-semibold text-slate-300">Source</th>
            <th className="pb-3 font-semibold text-slate-300">Duration</th>
            <th className="pb-3 font-semibold text-slate-300">Data</th>
            <th className="pb-3 font-semibold text-slate-300">Type</th>
            <th className="pb-3 font-semibold text-slate-300">IP</th>
          </tr>
        </thead>
        <tbody>
          {streams.map((stream, idx) => (
            <tr key={idx} className="border-b border-slate-800/50 hover:bg-slate-800/30">
              <td className="py-3 text-slate-200">{stream.channel}</td>
              <td className="py-3 text-slate-400">{stream.source}</td>
              <td className="py-3 text-slate-400">{stream.durationFormatted}</td>
              <td className="py-3 text-slate-400">{stream.bytesMB} MB</td>
              <td className="py-3">
                <span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ${
                  stream.type === 'stream' ? 'bg-blue-500/20 text-blue-300' :
                  stream.type === 'xtream_api' ? 'bg-purple-500/20 text-purple-300' :
                  'bg-green-500/20 text-green-300'
                }`}>
                  {stream.type}
                </span>
              </td>
              <td className="py-3 text-slate-500 text-xs">{stream.ip}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/**
 * DashboardView - Main dashboard component
 */
const DashboardView = () => {
  const { metrics, isConnected, error } = useMetrics();
  const { token } = useAuth();
  const [timeSeriesData, setTimeSeriesData] = useState({
    bandwidth: [],
    streams: [],
    requests: [],
    memory: []
  });

  // Fetch time-series data from API
  useEffect(() => {
    if (!token || !isConnected) return;

    const fetchTimeSeries = async () => {
      try {
        const baseUrl = window.location.hostname === 'localhost'
          ? ''
          : window.location.origin;

        const types = ['bandwidth', 'streams', 'requests', 'memory'];
        const promises = types.map(type =>
          fetch(`${baseUrl}/api/metrics/timeseries/${type}?minutes=10`, {
            headers: { 'Authorization': `Bearer ${token}` }
          }).then(res => res.json())
        );

        const results = await Promise.all(promises);
        const newData = {};
        results.forEach(result => {
          newData[result.type] = result.data;
        });

        setTimeSeriesData(newData);
      } catch (err) {
        console.error('[DashboardView] Failed to fetch time-series data:', err);
      }
    };

    fetchTimeSeries();

    // Refresh time-series data every 30 seconds (reduced from 5s to reduce load)
    const interval = setInterval(fetchTimeSeries, 30000);

    return () => clearInterval(interval);
  }, [token, isConnected]);

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950">
        <div className="text-center max-w-md">
          <div className="mb-4 inline-flex h-20 w-20 items-center justify-center rounded-full bg-red-500/20">
            <svg className="h-10 w-10 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div className="text-red-400 text-lg font-semibold mb-2">Dashboard Unavailable</div>
          <div className="text-slate-400">{error}</div>
          {error.includes('authenticated') && (
            <div className="mt-4 text-sm text-slate-500">
              Please log in to view the dashboard
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto"></div>
          <div className="text-slate-400 mt-4">Loading metrics...</div>
        </div>
      </div>
    );
  }

  const { streams, bandwidth, requests, connections, system } = metrics;

  return (
    <div className="min-h-screen bg-slate-950 p-6">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-100">Dashboard</h1>
            <p className="text-slate-400 mt-1">Real-time traffic monitoring</p>
          </div>
          <div className="flex items-center gap-2">
            <div className={`h-3 w-3 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}></div>
            <span className="text-sm text-slate-400">
              {isConnected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-6">
        <MetricCard
          title="Active Streams"
          value={streams.active}
          subtitle={streams.active === 1 ? '1 stream playing' : `${streams.active} streams playing`}
          icon="📺"
          color="blue"
        />
        <MetricCard
          title="Bandwidth"
          value={`${bandwidth.current.downloadMbps} Mbps`}
          subtitle={`Total: ${bandwidth.total.sentGB} GB sent`}
          icon="⚡"
          color="green"
        />
        <MetricCard
          title="Requests/min"
          value={requests.perMinute}
          subtitle={`${requests.total} total (${requests.errorRate}% errors)`}
          icon="📊"
          color="purple"
        />
        <MetricCard
          title="Uptime"
          value={system.uptime.formatted}
          subtitle={`Memory: ${system.memory.percentUsed}% (${system.memory.heapUsedMB} MB)`}
          icon="⏱️"
          color="orange"
        />
      </div>

      {/* Additional Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
          <h3 className="text-sm font-semibold text-slate-300 mb-4">Bandwidth Stats</h3>
          <div className="space-y-3">
            <div className="flex justify-between">
              <span className="text-slate-400">Upload:</span>
              <span className="text-slate-200">{bandwidth.current.uploadMbps} Mbps</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Download:</span>
              <span className="text-slate-200">{bandwidth.current.downloadMbps} Mbps</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Total Sent:</span>
              <span className="text-slate-200">{bandwidth.total.sentGB} GB</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Total Received:</span>
              <span className="text-slate-200">{bandwidth.total.receivedGB} GB</span>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
          <h3 className="text-sm font-semibold text-slate-300 mb-4">Request Stats</h3>
          <div className="space-y-3">
            <div className="flex justify-between">
              <span className="text-slate-400">Total:</span>
              <span className="text-slate-200">{requests.total.toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Successful:</span>
              <span className="text-green-400">{requests.successful.toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Errors:</span>
              <span className="text-red-400">{requests.errors.toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Error Rate:</span>
              <span className="text-slate-200">{requests.errorRate}%</span>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
          <h3 className="text-sm font-semibold text-slate-300 mb-4">System Info</h3>
          <div className="space-y-3">
            <div className="flex justify-between">
              <span className="text-slate-400">Node.js:</span>
              <span className="text-slate-200">{system.nodejs.version}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Memory:</span>
              <span className="text-slate-200">{system.memory.heapUsedMB} / {system.memory.heapTotalMB} MB</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Usage:</span>
              <span className={`font-semibold ${
                parseFloat(system.memory.percentUsed) > 75 ? 'text-red-400' : 'text-green-400'
              }`}>
                {system.memory.percentUsed}%
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">SSE Clients:</span>
              <span className="text-slate-200">{connections.sse}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Graphs Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Bandwidth Chart */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
          <h3 className="text-lg font-semibold text-slate-300 mb-4">
            Bandwidth (Last 10 minutes)
          </h3>
          <BandwidthChart data={timeSeriesData.bandwidth} height={250} />
        </div>

        {/* Active Streams Chart */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
          <h3 className="text-lg font-semibold text-slate-300 mb-4">
            Active Streams (Last 10 minutes)
          </h3>
          <StreamsChart data={timeSeriesData.streams} height={250} />
        </div>

        {/* Requests Chart */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
          <h3 className="text-lg font-semibold text-slate-300 mb-4">
            Requests/min (Last 10 minutes)
          </h3>
          <RequestsChart data={timeSeriesData.requests} height={250} />
        </div>

        {/* Memory Chart */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
          <h3 className="text-lg font-semibold text-slate-300 mb-4">
            Memory Usage (Last 10 minutes)
          </h3>
          <MemoryChart data={timeSeriesData.memory} height={250} />
        </div>
      </div>

      {/* Stream Type Distribution, Active Users, and Page Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Stream Type Chart */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
          <h3 className="text-lg font-semibold text-slate-300 mb-4">
            Stream Type Distribution
          </h3>
          <StreamTypeChart streams={streams.list} height={300} />
        </div>

        {/* Page Activity */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
          <h3 className="text-lg font-semibold text-slate-300 mb-4">
            Page Activity
          </h3>
          <PageActivityPanel />
        </div>

        {/* Active Users */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
          <h3 className="text-lg font-semibold text-slate-300 mb-4">
            Active Users
          </h3>
          <ActiveSessionsPanel streams={streams.list} />
        </div>

        {/* Commercial Detection Learning Data */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6 md:col-span-2 lg:col-span-3">
          <h3 className="text-lg font-semibold text-slate-300 mb-4">
            Commercial-Detection Hotlist
          </h3>
          <CommercialDetectionPanel />
        </div>
      </div>

      {/* AI Channel Matching control + telemetry */}
      <div className="mb-6">
        <AiMatchingPanel />
      </div>

      {/* Active Streams Table */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
        <h3 className="text-lg font-semibold text-slate-300 mb-4">
          Active Streams ({streams.active})
        </h3>
        <ActiveStreamsTable streams={streams.list} />
      </div>
    </div>
  );
};

export default DashboardView;
