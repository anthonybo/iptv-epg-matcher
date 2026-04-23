import React from 'react';

const inputClasses =
  'w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500/60';

const EditCredentialsModal = ({ sourceId, credentials, onChange, onSubmit, onClose }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
    <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-lg w-full">
      <div className="bg-slate-800 px-6 py-4 border-b border-slate-700 flex items-center justify-between">
        <h3 className="text-xl font-semibold text-slate-100">Edit Credentials</h3>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-200 transition-colors p-1 hover:bg-slate-700 rounded-lg"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className="p-6 space-y-4"
      >
        <div>
          <label htmlFor={`url-${sourceId}`} className="block text-sm font-medium text-slate-300 mb-2">
            Server URL
          </label>
          <input
            id={`url-${sourceId}`}
            type="url"
            name="url"
            autoComplete="url"
            value={credentials.url}
            onChange={(e) => onChange({ ...credentials, url: e.target.value })}
            className={inputClasses}
            placeholder="http://example.com:8080"
            required
          />
        </div>

        <div>
          <label htmlFor={`username-${sourceId}`} className="block text-sm font-medium text-slate-300 mb-2">
            Username
          </label>
          <input
            id={`username-${sourceId}`}
            type="text"
            name="username"
            autoComplete="username"
            value={credentials.username}
            onChange={(e) => onChange({ ...credentials, username: e.target.value })}
            className={inputClasses}
            placeholder="username"
          />
        </div>

        <div>
          <label htmlFor={`password-${sourceId}`} className="block text-sm font-medium text-slate-300 mb-2">
            Password
          </label>
          <input
            id={`password-${sourceId}`}
            type="password"
            name="password"
            autoComplete="current-password"
            value={credentials.password}
            onChange={(e) => onChange({ ...credentials, password: e.target.value })}
            className={inputClasses}
            placeholder="password"
          />
        </div>

        <div className="bg-slate-800 px-6 py-4 -mx-6 -mb-6 border-t border-slate-700 flex gap-3 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-white font-medium transition-colors"
          >
            Save & Refresh
          </button>
        </div>
      </form>
    </div>
  </div>
);

export default EditCredentialsModal;
