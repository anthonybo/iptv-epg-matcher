import React from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts';

/**
 * StreamTypeChart - Shows distribution of stream types (pie chart)
 * Props:
 *   - streams: Array of stream objects with 'type' property
 *   - height: Chart height (default: 300)
 */
const StreamTypeChart = ({ streams, height = 300 }) => {
  if (!streams || streams.length === 0) {
    return (
      <div className="flex items-center justify-center h-full" style={{ height }}>
        <div className="text-slate-500">No active streams</div>
      </div>
    );
  }

  // Count streams by type
  const typeCounts = streams.reduce((acc, stream) => {
    const type = stream.type || 'unknown';
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});

  // Convert to array for recharts
  const data = Object.entries(typeCounts).map(([name, value]) => ({
    name: formatTypeName(name),
    value,
    rawType: name
  }));

  // Define colors for different stream types
  const COLORS = {
    'stream': '#3b82f6',      // blue
    'xtream_api': '#a855f7',  // purple
    'xtream_direct': '#22c55e', // green
    'xtream': '#f97316',      // orange
    'unknown': '#64748b'      // slate
  };

  // Format type name for display
  function formatTypeName(type) {
    const names = {
      'stream': 'Web App',
      'xtream_api': 'Xtream API',
      'xtream_direct': 'Xtream Direct',
      'xtream': 'Xtream',
      'unknown': 'Unknown'
    };
    return names[type] || type;
  }

  // Custom label
  const renderLabel = (entry) => {
    return `${entry.name}: ${entry.value}`;
  };

  // Custom tooltip
  const CustomTooltip = ({ active, payload }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-slate-900 border border-slate-700 rounded-lg p-3 shadow-lg">
          <p className="text-slate-200 font-semibold">{data.name}</p>
          <p className="text-slate-400 text-sm">
            {data.value} {data.value === 1 ? 'stream' : 'streams'}
          </p>
          <p className="text-slate-500 text-xs mt-1">
            {((data.value / streams.length) * 100).toFixed(1)}% of total
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          labelLine={false}
          label={renderLabel}
          outerRadius={80}
          fill="#8884d8"
          dataKey="value"
        >
          {data.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={COLORS[entry.rawType] || COLORS.unknown} />
          ))}
        </Pie>
        <Tooltip content={<CustomTooltip />} />
        <Legend
          wrapperStyle={{ fontSize: '12px', color: '#94a3b8' }}
          iconType="circle"
        />
      </PieChart>
    </ResponsiveContainer>
  );
};

export default StreamTypeChart;
