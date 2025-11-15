import React from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

/**
 * MemoryChart - Shows memory usage over time
 * Props:
 *   - data: Array of { timestamp, usedMB, totalMB, percent }
 *   - height: Chart height (default: 300)
 */
const MemoryChart = ({ data, height = 300 }) => {
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full" style={{ height }}>
        <div className="text-slate-500">No memory data available</div>
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
            <p className="text-orange-400 text-sm">
              Used: {payload[0].value.toFixed(1)} MB
            </p>
            <p className="text-slate-400 text-sm">
              Total: {payload[0].payload.totalMB} MB
            </p>
            <p className="text-slate-400 text-sm">
              Usage: {payload[0].payload.percent.toFixed(1)}%
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
          label={{ value: 'Memory (MB)', angle: -90, position: 'insideLeft', style: { fill: '#94a3b8', fontSize: '12px' } }}
        />
        <Tooltip content={<CustomTooltip />} />
        <Line
          type="monotone"
          dataKey="usedMB"
          stroke="#f97316"
          name="Memory Used"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
};

export default MemoryChart;
