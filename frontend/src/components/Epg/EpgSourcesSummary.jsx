import React from 'react';
import '../../styles.css';

const formatNumber = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '0';
  }
  return numeric.toLocaleString();
};

const pickNumeric = (source, keys) => {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return numeric;
      }
    }
  }
  return 0;
};

const formatDateTime = (value) => {
  if (!value) {
    return 'Unknown';
  }

  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return date.toLocaleString();
  } catch (err) {
    return value;
  }
};

const EpgSourcesSummary = ({ sources = [] }) => {
  if (!sources.length) {
    return (
      <div className="epg-summary">
        <h3>Current EPG Sources</h3>
        <div className="status-message">
          No EPG sources loaded yet. Use the controls below to add one or load defaults from your provider.
        </div>
      </div>
    );
  }

  const totals = sources.reduce(
    (acc, source) => {
      acc.channels += pickNumeric(source, ['channelCount', 'channel_count', 'channels']);
      acc.programs += pickNumeric(source, ['programCount', 'program_count', 'programs', 'program_total']);
      return acc;
    },
    { channels: 0, programs: 0 }
  );

  const averageChannels = Math.round(totals.channels / sources.length) || 0;
  const averageProgramsPerChannel =
    totals.channels > 0 ? Math.round(totals.programs / totals.channels) : 0;

  return (
    <div className="epg-summary">
      <h3>Current EPG Sources</h3>

      <div className="summary-stats">
        <div className="stat-item">
          <div className="stat-value">{formatNumber(sources.length)}</div>
          <div className="stat-label">Sources</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{formatNumber(totals.channels)}</div>
          <div className="stat-label">Total Channels</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{formatNumber(totals.programs)}</div>
          <div className="stat-label">Total Programs</div>
        </div>
      </div>

      <div className="averages">
        <div>
          <strong>Avg. Channels per Source:</strong> {formatNumber(averageChannels)}
        </div>
        <div>
          <strong>Avg. Programs per Channel:</strong> {formatNumber(averageProgramsPerChannel)}
        </div>
      </div>

      <h4>Source Details</h4>
      <div className="source-list">
        {sources.map((source, index) => {
          const channels = pickNumeric(source, ['channelCount', 'channel_count', 'channels']);
          const programs = pickNumeric(source, ['programCount', 'program_count', 'programs', 'program_total']);
          return (
            <div key={source.id || source.url || index} className="source-item">
              <div className="source-name">
                {source.name || source.title || 'Unnamed Source'}
              </div>
              {source.url && (
                <div className="source-url">{source.url}</div>
              )}
              <div className="source-counts">
                <span>{formatNumber(channels)} channels</span>
                <span>{formatNumber(programs)} programs</span>
              </div>
              <div className="source-updated">
                Last updated: {formatDateTime(source.lastUpdated || source.updatedAt || source.updated_at)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default EpgSourcesSummary;
