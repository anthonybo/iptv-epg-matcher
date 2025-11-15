import React from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

/**
 * BandwidthChart - Shows bandwidth usage over time
 * Props:
 *   - data: Array of { timestamp, uploadMbps, downloadMbps }
 *   - height: Chart height (default: 300)
 */
const BandwidthChart = ({ data, height = 300 }) => {
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full" style={{ height }}>
        <div className="text-slate-500">No bandwidth data available</div>
      </div>
    );
  }

  // Format timestamp for display
  const formatTime = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  // Custom tooltip
  const CustomTooltip = ({ active, payload }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-slate-900 border border-slate-700 rounded-lg p-3 shadow-lg">
          <p className="text-slate-300 text-xs mb-2">{formatTime(payload[0].payload.timestamp)}</p>
          <div className="space-y-1">
            <p className="text-green-400 text-sm">
              Download: {payload[0].value.toFixed(2)} Mbps
            </p>
            <p className="text-blue-400 text-sm">
              Upload: {payload[1].value.toFixed(2)} Mbps
            </p>
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 5, right: 30, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
        <XAxis
          dataKey="timestamp"
          tickFormatter={formatTime}
          stroke="#94a3b8"
          style={{ fontSize: '12px' }}
        />
        <YAxis
          stroke="#94a3b8"
          style={{ fontSize: '12px' }}
          label={{ value: 'Mbps', angle: -90, position: 'insideLeft', style: { fill: '#94a3b8', fontSize: '12px' } }}
        />
        <Tooltip content={<CustomTooltip />} />
        <Legend
          wrapperStyle={{ fontSize: '12px', color: '#94a3b8' }}
        />
        <Line
          type="monotone"
          dataKey="downloadMbps"
          stroke="#22c55e"
          name="Download"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
        <Line
          type="monotone"
          dataKey="uploadMbps"
          stroke="#3b82f6"
          name="Upload"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
};

export default BandwidthChart;
