import React from 'react';

/**
 * StatusDisplay component for showing status messages
 * 
 * @param {Object} props Component properties
 * @param {string} props.message The message to display
 * @param {string} props.type Message type ('info', 'success', 'error', 'warning')
 * @returns {JSX.Element} Status message display
 */
const StatusDisplay = ({ message, type = 'info' }) => {
  if (!message) return null;

  const variant = (() => {
    switch (type) {
      case 'success':
        return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100';
      case 'error':
        return 'border-rose-500/40 bg-rose-500/10 text-rose-100';
      case 'warning':
        return 'border-amber-500/40 bg-amber-500/10 text-amber-100';
      case 'info':
      default:
        return 'border-sky-500/40 bg-sky-500/10 text-sky-100';
    }
  })();

  const icon = (() => {
    switch (type) {
      case 'success':
        return (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            className="h-5 w-5 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
          </svg>
        );
      case 'error':
        return (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            className="h-5 w-5 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          </svg>
        );
      case 'warning':
        return (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            className="h-5 w-5 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
        );
      case 'info':
      default:
        return (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            className="h-5 w-5 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>
        );
    }
  })();

  return (
    <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-inner ${variant}`}>
      <span className="mt-0.5">{icon}</span>
      <span className="flex-1 leading-relaxed">{message}</span>
    </div>
  );
};

export default StatusDisplay;
