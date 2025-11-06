import React, { useState, useEffect } from 'react';
import apiClient from './utils/apiClient';

const LabelValueRow = ({ label, value, onCopy, copiedId, setCopiedId, copyId }) => {
  const handleCopy = () => {
    onCopy(value);
    setCopiedId(copyId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-slate-800/70 bg-slate-900/60 p-4 shadow-inner shadow-slate-950/20">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">{label}</span>
        <button
          type="button"
          onClick={handleCopy}
          className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1 text-xs font-semibold transition ${
            copiedId === copyId
              ? 'border-emerald-500 bg-emerald-500/20 text-emerald-200'
              : 'border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800'
          }`}
        >
          {copiedId === copyId ? (
            <>
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Copied!
            </>
          ) : (
            <>
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              Copy
            </>
          )}
        </button>
      </div>
      <div className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 break-all">
        {value}
      </div>
    </div>
  );
};

const DeleteConfirmModal = ({ isOpen, onConfirm, onCancel }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-md rounded-2xl border border-slate-800 bg-slate-950 p-6 shadow-2xl">
        <div className="mb-4 flex items-start gap-3">
          <div className="rounded-full bg-rose-500/20 p-2">
            <svg className="h-6 w-6 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-100">Delete Credential?</h3>
            <p className="mt-2 text-sm text-slate-400">
              Are you sure you want to delete this credential? This action cannot be undone.
            </p>
          </div>
        </div>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 rounded-lg border border-rose-700 bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-rose-500"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
};

const CredentialCard = ({ credential, onDelete, onCopy, copiedId, setCopiedId }) => {
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const handleDeleteClick = () => {
    setShowDeleteModal(true);
  };

  const handleConfirmDelete = async () => {
    setShowDeleteModal(false);
    setIsDeleting(true);
    try {
      await onDelete(credential.credential_id);
    } catch (error) {
      console.error('Failed to delete credential:', error);
      setIsDeleting(false);
    }
  };

  const handleCancelDelete = () => {
    setShowDeleteModal(false);
  };

  const createdDate = new Date(credential.created_at).toLocaleString();

  return (
    <div className="rounded-3xl border border-slate-800/70 bg-slate-950/70 p-6 shadow-2xl shadow-slate-950/40">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <div className="text-xs text-slate-500">Created {createdDate}</div>
          <div className="mt-1 text-sm text-slate-400">{credential.channel_count} channels</div>
        </div>
        <button
          onClick={handleDeleteClick}
          disabled={isDeleting}
          className="inline-flex items-center gap-2 rounded-lg border border-rose-700 bg-rose-900 px-3 py-1.5 text-xs font-semibold text-rose-200 transition hover:bg-rose-800 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isDeleting ? (
            <>
              <svg className="h-4 w-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" strokeWidth="3" stroke="currentColor" strokeOpacity="0.25"></circle>
                <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" opacity="0.75"></path>
              </svg>
              Deleting...
            </>
          ) : (
            <>
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              Delete
            </>
          )}
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <LabelValueRow
          label="Server URL"
          value={credential.xtreamUrl}
          onCopy={onCopy}
          copiedId={copiedId}
          setCopiedId={setCopiedId}
          copyId={`${credential.credential_id}-url`}
        />
        <LabelValueRow
          label="Username"
          value={credential.username}
          onCopy={onCopy}
          copiedId={copiedId}
          setCopiedId={setCopiedId}
          copyId={`${credential.credential_id}-username`}
        />
        <LabelValueRow
          label="Password"
          value={credential.password}
          onCopy={onCopy}
          copiedId={copiedId}
          setCopiedId={setCopiedId}
          copyId={`${credential.credential_id}-password`}
        />
        <LabelValueRow
          label="EPG URL"
          value={credential.xtreamEpgUrl}
          onCopy={onCopy}
          copiedId={copiedId}
          setCopiedId={setCopiedId}
          copyId={`${credential.credential_id}-epg`}
        />
      </div>

      {credential.m3uUrl && (
        <div className="mt-4 rounded-2xl border border-blue-500/40 bg-blue-500/10 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-[0.25em] text-blue-200">Direct M3U Link</h4>
            <button
              onClick={() => {
                onCopy(credential.m3uUrl);
                setCopiedId(`${credential.credential_id}-m3u`);
                setTimeout(() => setCopiedId(null), 2000);
              }}
              className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1 text-xs font-semibold transition ${
                copiedId === `${credential.credential_id}-m3u`
                  ? 'border-emerald-500 bg-emerald-500/20 text-emerald-200'
                  : 'border-blue-700 bg-blue-900 text-blue-200 hover:bg-blue-800'
              }`}
            >
              {copiedId === `${credential.credential_id}-m3u` ? (
                <>
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Copied!
                </>
              ) : (
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                  Copy
                </>
              )}
            </button>
          </div>
          <div className="rounded-xl border border-blue-800 bg-blue-950 px-3 py-2 text-xs text-blue-100 break-all">
            {credential.m3uUrl}
          </div>
        </div>
      )}

      <DeleteConfirmModal
        isOpen={showDeleteModal}
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
    </div>
  );
};

const ResultView = ({ onCopyToClipboard, onBackToPlayer, onGenerate, isGenerating, matchedChannelsCount }) => {
  const [credentials, setCredentials] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState(null);
  const hasMatches = matchedChannelsCount > 0;

  const loadCredentials = async () => {
    try {
      setLoading(true);
      const response = await apiClient.get('/generate');
      setCredentials(response.data.credentials || []);
    } catch (error) {
      console.error('Failed to load credentials:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCredentials();
  }, []);

  const handleDelete = async (credentialId) => {
    await apiClient.delete(`/generate/${credentialId}`);
    // Reload credentials after delete
    await loadCredentials();
  };

  const handleGenerate = async () => {
    await onGenerate();
    // Reload credentials after generating
    await loadCredentials();
  };

  const handleCopy = (text) => {
    onCopyToClipboard(text);
  };

  if (loading) {
    return (
      <section className="px-6 py-12">
        <div className="flex items-center justify-center">
          <svg className="h-8 w-8 animate-spin text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" strokeWidth="3" stroke="currentColor" strokeOpacity="0.25"></circle>
            <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" opacity="0.75"></path>
          </svg>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-6 px-6 py-12">
      <div className="flex items-center justify-between">
        <div className="inline-flex items-center gap-3 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-200">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
          </svg>
          XTREAM Credentials
        </div>

        <button
          type="button"
          onClick={handleGenerate}
          disabled={!hasMatches || isGenerating}
          className={`inline-flex items-center gap-2 rounded-xl px-6 py-3 text-sm font-semibold shadow-lg transition ${
            !hasMatches || isGenerating
              ? 'cursor-not-allowed bg-slate-700 text-slate-400'
              : 'bg-emerald-600 text-white shadow-emerald-900/40 hover:bg-emerald-500'
          }`}
        >
          {isGenerating ? (
            <svg className="h-4 w-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" strokeWidth="3" stroke="currentColor" strokeOpacity="0.25"></circle>
              <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" opacity="0.75"></path>
            </svg>
          ) : (
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          )}
          {isGenerating ? 'Generating…' : 'Generate New Credentials'}
        </button>
      </div>

      {hasMatches && (
        <div className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className="font-semibold">{matchedChannelsCount} matched channels ready</span>
        </div>
      )}

      {!hasMatches && credentials.length === 0 && (
        <div className="rounded-3xl border border-slate-800/70 bg-slate-950/70 p-10 text-center shadow-2xl shadow-slate-950/40">
          <svg xmlns="http://www.w3.org/2000/svg" className="mx-auto mb-6 h-16 w-16 text-slate-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>
          <h3 className="text-lg font-semibold text-slate-100">No credentials generated yet</h3>
          <p className="mt-2 text-sm text-slate-400">
            Generate XTREAM credentials to create your own IPTV service with only your matched channels.
          </p>
          <p className="mt-4 text-xs font-medium text-rose-300">
            Match at least one channel with EPG data before generating credentials.
          </p>
        </div>
      )}

      {credentials.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-slate-100">
            Your Credentials ({credentials.length})
          </h3>
          {credentials.map((credential) => (
            <CredentialCard
              key={credential.credential_id}
              credential={credential}
              onDelete={handleDelete}
              onCopy={handleCopy}
              copiedId={copiedId}
              setCopiedId={setCopiedId}
            />
          ))}
        </div>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onBackToPlayer}
          className="inline-flex items-center gap-2 rounded-xl border border-blue-500/40 bg-blue-500/10 px-4 py-2 text-sm font-semibold text-blue-100 transition hover:bg-blue-500/20"
        >
          Return to Player
        </button>
      </div>
    </section>
  );
};

export default ResultView;
