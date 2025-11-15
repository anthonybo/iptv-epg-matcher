import React from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';

/**
 * RequestsChart - Shows requests per minute over time
 * Props:
 *   - data: Array of { timestamp, count }
 *   - height: Chart height (default: 300)
 */
const RequestsChart = ({ data, height = 300 }) => {
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full" style={{ height }}>
        <div className="text-slate-500">No request data available</div>
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
          <p className="text-purple-400 text-sm">
            Requests/min: {payload[0].value}
          </p>
        </div>
      );
    }
    return null;
  };

  // Calculate average for color coding
  const average = data.reduce((sum, item) => sum + item.count, 0) / data.length;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 5, right: 30, left: 0, bottom: 5 }}>
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
          allowDecimals={false}
          label={{ value: 'Requests/min', angle: -90, position: 'insideLeft', style: { fill: '#94a3b8', fontSize: '12px' } }}
        />
        <Tooltip content={<CustomTooltip />} />
        <Bar
          dataKey="count"
          name="Requests per minute"
        >
          {data.map((entry, index) => (
            <Cell
              key={`cell-${index}`}
              fill={entry.count > average * 1.5 ? '#f59e0b' : '#a855f7'}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
};

export default RequestsChart;
