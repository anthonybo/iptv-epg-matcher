import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import logger from '../../utils/logger';

// Debug tag for every log line in this file. Filter by this string
// in the backend log to see only the drag/drop pipeline.
const LOG_TAG = '[FavStrip:DnD]';
const dlog = (msg, ctx = {}) => {
  try {
    // Inline the context JSON in the message string because the
    // backend log file transport doesn't write the Winston `meta`
    // arg. Without this we'd see "handleDrop called" with no payload.
    const tail = ctx && Object.keys(ctx).length ? ' ' + JSON.stringify(ctx) : '';
    logger.info(`${LOG_TAG} ${msg}${tail}`);
  } catch (_) {}
};

/**
 * FavoritesStrip — slim horizontal rail of "preset" chips.
 *
 * AESTHETIC DIRECTION: Industrial Control Surface.
 * Think Bloomberg terminal × Eurorack panel. Folders are NOT cute iOS
 * blobs — they're literal "stacked-card" affordances with offset shadow
 * layers behind them, mono-tabular count badges in brackets, and amber
 * accents that read as "active/alert" not "decoration". Animations are
 * crisp (150–200ms, cubic-bezier(0.4,0,0.2,1)), never bouncy.
 *
 * ───────────────────────────────────────────────────────────────────
 * Props
 * ───────────────────────────────────────────────────────────────────
 *   favorites          — array. Each: { id, name, logo, sourceType,
 *                        sourceId, channelId, sourceName, sourceUrl,
 *                        sourceUsername, sourceMac, position,
 *                        folderId?, folderPosition? }
 *   folders            — array of folders: { id, name, color?, position }
 *                        Pass empty array if the backend hasn't shipped
 *                        folders yet — the strip degrades to the
 *                        flat-rail behaviour from before.
 *   streams, streamOrder — same as before, drives the live-tile badge.
 *   onPlay(favorite)   — caller wires to addToMultiview + bumpPlayed
 *   onRemove(id)       — remove a favorite outright
 *   onCreateFolder({ name, memberIds }) → Promise<folderId>
 *                        Caller persists, returns the new folder id.
 *   onRenameFolder(folderId, name) → Promise
 *   onDeleteFolder(folderId) → Promise
 *                        Children fall back to top-level (folder_id=null).
 *   onMoveFavorite(favId, { folderId, position }) → Promise
 *                        null folderId = move out to top level.
 *
 * The component is purely presentational; all mutation is deferred to
 * the parent. Folders are derived from `folders` + `favorites.folderId`.
 *
 * ───────────────────────────────────────────────────────────────────
 * HTML5 DnD gotchas baked in below
 * ───────────────────────────────────────────────────────────────────
 *   • dragover MUST preventDefault or `drop` never fires.
 *   • setDragImage must run synchronously inside dragstart on an
 *     element already in the DOM — we use the chip element itself.
 *   • dragleave bubbles from children; we track a depth counter per
 *     target to avoid flicker.
 *   • The dragged element's click event is suppressed by the browser
 *     when a drag actually occurs (≥3px movement), so plain click
 *     still works for play (no separate "drag handle" required).
 *   • Touch devices don't fire HTML5 DnD — folders can still be
 *     created on touch via the "+" affordance in the popover (TBD;
 *     left as a follow-up — current implementation is mouse-first).
 *   • dataTransfer payloads are coerced to strings — we JSON-encode
 *     to preserve { kind, favId, fromFolderId }.
 *
 * ───────────────────────────────────────────────────────────────────
 * Backend additions (separate PR — included here as a doc anchor)
 * ───────────────────────────────────────────────────────────────────
 *   New table:
 *     channel_favorite_folders (
 *       id SERIAL PK,
 *       user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 *       name VARCHAR(80) NOT NULL,
 *       color VARCHAR(16),
 *       position INT NOT NULL DEFAULT 0,
 *       created_at TIMESTAMP NOT NULL DEFAULT now()
 *     );
 *   Migration on channel_favorites:
 *     ADD COLUMN folder_id INT REFERENCES channel_favorite_folders(id)
 *                ON DELETE SET NULL,
 *     ADD COLUMN folder_position INT NOT NULL DEFAULT 0;
 *     CREATE INDEX idx_channel_favorites_user_folder
 *       ON channel_favorites(user_id, folder_id, folder_position);
 *   Endpoints:
 *     POST   /api/favorites/folders               → create
 *     PATCH  /api/favorites/folders/:id           → rename / reorder
 *     DELETE /api/favorites/folders/:id           → unsetfolder_id on children
 *     PATCH  /api/favorites/:favId/move           → body { folderId, position }
 *                                                   null folderId = top level
 *   GET /api/favorites response shape changes:
 *     { favorites: [...], folders: [...] }
 */

// ─── Style block (injected once — Tailwind config can't host these) ──
//
// All keyframes here are tightly scoped to this rail. Naming uses a
// `favstrip-` prefix so a sibling component can't accidentally
// clobber them. We use cubic-bezier(0.4,0,0.2,1) — the same
// material-fast curve the rest of the app uses for hover transitions.

const FAVSTRIP_STYLES = `
@keyframes favstrip-folder-glow {
  0%, 100% {
    box-shadow:
      0 0 0 1px rgba(251, 191, 36, 0.55),
      0 0 0 3px rgba(251, 191, 36, 0.12),
      0 6px 18px -6px rgba(251, 191, 36, 0.35);
  }
  50% {
    box-shadow:
      0 0 0 1px rgba(251, 191, 36, 0.85),
      0 0 0 4px rgba(251, 191, 36, 0.18),
      0 8px 22px -6px rgba(251, 191, 36, 0.50);
  }
}
@keyframes favstrip-popover-in {
  from { opacity: 0; transform: translateY(-2px) scaleY(0.97); transform-origin: top; }
  to   { opacity: 1; transform: translateY(0)    scaleY(1);    transform-origin: top; }
}
@keyframes favstrip-merge-flash {
  0%   { transform: scale(1);    background-color: rgba(251, 191, 36, 0); }
  40%  { transform: scale(1.025); background-color: rgba(251, 191, 36, 0.14); }
  100% { transform: scale(1);    background-color: rgba(251, 191, 36, 0); }
}
@keyframes favstrip-stripes {
  from { background-position: 0 0; }
  to   { background-position: 8px 0; }
}
.favstrip-stripes {
  background-image: repeating-linear-gradient(
    -45deg,
    rgba(251, 191, 36, 0.06) 0px,
    rgba(251, 191, 36, 0.06) 2px,
    transparent 2px,
    transparent 4px
  );
  animation: favstrip-stripes 0.6s linear infinite;
}
`;

if (typeof document !== 'undefined' && !document.getElementById('favstrip-styles')) {
  const el = document.createElement('style');
  el.id = 'favstrip-styles';
  el.textContent = FAVSTRIP_STYLES;
  document.head.appendChild(el);
}

// ─── Helpers ──────────────────────────────────────────────────────────

const railFor = (type) => {
  switch (type) {
    case 'xtream':  return 'from-sky-400 to-blue-500';
    case 'stalker': return 'from-violet-400 to-purple-500';
    case 'm3u':     return 'from-emerald-400 to-teal-500';
    case 'youtube': return 'from-rose-400 to-red-500';
    default:        return 'from-slate-500 to-slate-600';
  }
};

const subtitleFor = (f) => {
  if (f.sourceType === 'stalker' && f.sourceMac) return f.sourceMac;
  if (f.sourceUsername) return `@${f.sourceUsername}`;
  return f.sourceName || 'Source';
};

const hostOf = (url) => {
  if (!url) return null;
  try { return new URL(url).host.toLowerCase(); } catch { return null; }
};

// DataTransfer payload schema. We JSON-encode/decode so we can carry
// structured intent across the drag boundary instead of just a string id.
const DT_MIME = 'application/x-iptv-favstrip+json';
const encodeDrag = (payload) => JSON.stringify(payload);
const decodeDrag = (ev) => {
  try {
    const raw = ev.dataTransfer.getData(DT_MIME) || ev.dataTransfer.getData('text/plain');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
};

// Build the top-level item order from favorites + folders.
//
// Output items are tagged: { kind: 'chip', fav } | { kind: 'folder', folder, children }.
// Folders position themselves by `folder.position`; top-level chips
// (folderId == null) position by `favorite.position`. We interleave
// the two by position and break ties by recency.
function buildTopLevel(favorites, folders) {
  const byFolder = new Map();
  const topLevel = [];

  favorites.forEach((f) => {
    if (f.folderId != null) {
      const arr = byFolder.get(f.folderId) || [];
      arr.push(f);
      byFolder.set(f.folderId, arr);
    } else {
      topLevel.push({ kind: 'chip', fav: f, position: f.position ?? 0 });
    }
  });

  // Sort each folder's children by folder_position then recency
  for (const arr of byFolder.values()) {
    arr.sort((a, b) => (a.folderPosition ?? 0) - (b.folderPosition ?? 0));
  }

  folders.forEach((folder) => {
    topLevel.push({
      kind: 'folder',
      folder,
      children: byFolder.get(folder.id) || [],
      position: folder.position ?? 0
    });
  });

  topLevel.sort((a, b) => a.position - b.position);
  return topLevel;
}

// ─── Main ─────────────────────────────────────────────────────────────

const FavoritesStrip = ({
  favorites = [],
  folders = [],
  streams = [],
  streamOrder = {},
  onPlay,
  onRemove,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveFavorite,
  // Unified top-level reorder: receives [{ kind: 'chip' | 'folder', id }]
  // in the desired order and persists positions across both tables.
  onReorderTopLevel
}) => {
  const [playingKey, setPlayingKey] = useState(null);
  const [removingId, setRemovingId] = useState(null);
  const railRef = useRef(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // Drag state — one source of truth. While a drag is active, this
  // describes what's being dragged, where, and what intent the user
  // is currently expressing (merge into a chip, drop on a folder,
  // remove from a folder, reorder).
  const [drag, setDrag] = useState(null);
  // shape: { sourceFavId, fromFolderId, overTargetId, overKind, intent }

  // Open folder popover — only one open at a time. Stores the folder id.
  const [openFolderId, setOpenFolderId] = useState(null);

  // Folder that just got created (or chip whose folder was just
  // renamed) — focus inline rename input.
  const [pendingRenameId, setPendingRenameId] = useState(null);

  // Folder that should flash (just merged into) — clears 350ms later.
  const [flashFolderId, setFlashFolderId] = useState(null);

  // ── Scroll affordances on the rail ────────────────────────────────
  useEffect(() => {
    const el = railRef.current;
    if (!el) return undefined;
    const update = () => {
      setCanScrollLeft(el.scrollLeft > 2);
      setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [favorites, folders]);

  // ── Live-slot map: which fav is in which multi-view tile ──────────
  const liveSlots = useMemo(() => {
    const map = new Map();
    streams.forEach((s, i) => {
      const sk = `${s.sourceId}_${s.id}_${s._refreshKey || ''}`;
      const visualOrder = streamOrder?.[sk] ?? i;
      map.set(`${s.sourceId}::${s.id}`, visualOrder + 1);
    });
    return map;
  }, [streams, streamOrder]);

  // ── Top-level item list (chips + folders interleaved by position) ─
  const topLevel = useMemo(
    () => buildTopLevel(favorites, folders),
    [favorites, folders]
  );

  // For the count label: top-level item count vs total channel count.
  const totalChannelCount = favorites.length;
  const topLevelCount = topLevel.length;

  // ── Action handlers ───────────────────────────────────────────────
  const handlePlay = async (fav) => {
    if (!onPlay || playingKey || removingId === fav.id) return;
    const key = `${fav.sourceId}::${fav.channelId}`;
    setPlayingKey(key);
    try {
      await onPlay(fav);
      // Close any open folder once a play succeeds — gives clear feedback.
      setOpenFolderId(null);
    } finally {
      setPlayingKey(null);
    }
  };

  const handleRemove = async (fav) => {
    if (!onRemove || removingId) return;
    setRemovingId(fav.id);
    try { await onRemove(fav.id); }
    finally { setRemovingId(null); }
  };

  // Drop handler — dispatches by drag source kind + drop target kind.
  //
  // Intent table (top-level drops):
  //   chip   → chip          : create folder with both
  //   chip   → folder        : add chip to folder
  //   chip   → separator     : reorder chip to that position
  //   folder → chip / folder : no-op (no nested folders v1)
  //   folder → separator     : reorder folder to that position
  //   chip   → strip-bg      : (only if dragged from folder popover) remove from folder
  const handleDrop = useCallback(async (target) => {
    dlog('handleDrop called', { target, drag });
    if (!drag) {
      dlog('handleDrop bail: no drag state');
      return;
    }
    const { sourceKind, sourceFavId, sourceFolderId, fromFolderId } = drag;
    setDrag(null);

    // ── Popover-drag (chip dragged out of a folder) ──────────────
    // The chip is currently inside `fromFolderId`. The drop target
    // tells us where it should go:
    //   • another folder       → move into that folder
    //   • chip / separator     → leave folder, land at top-level pos
    //   • strip-background     → leave folder, append at end
    if (fromFolderId != null) {
      if (!onMoveFavorite) {
        dlog('popover drop bail: onMoveFavorite not provided');
        return;
      }
      if (target.kind === 'folder' && target.folderId !== fromFolderId) {
        dlog('popover drop: → other folder', { folderId: target.folderId });
        await onMoveFavorite(sourceFavId, { folderId: target.folderId, position: -1 });
        return;
      }
      if (target.kind === 'folder' && target.folderId === fromFolderId) {
        dlog('popover drop: same folder, no-op');
        return;
      }
      let pos = -1;
      if (target.kind === 'separator') {
        pos = target.position;
      } else if (target.kind === 'chip') {
        // Drop before this chip = at that chip's top-level index.
        const targetIdx = topLevel.findIndex(it => it.kind === 'chip' && it.fav.id === target.favId);
        if (targetIdx >= 0) pos = targetIdx;
      }
      dlog('popover drop: → top-level', { pos, targetKind: target.kind });
      await onMoveFavorite(sourceFavId, { folderId: null, position: pos });
      return;
    }

    // Reorder into a separator slot.
    if (target.kind === 'separator') {
      if (!onReorderTopLevel) {
        dlog('handleDrop bail: onReorderTopLevel not provided');
        return;
      }
      // Locate the source in the current top-level list so we can
      // adjust the target index after filtering it out — see the
      // off-by-one comment below.
      const sourceOriginalIdx = topLevel.findIndex((it) =>
        sourceKind === 'folder'
          ? it.kind === 'folder' && it.folder.id === sourceFolderId
          : it.kind === 'chip' && it.fav.id === sourceFavId
      );
      dlog('separator drop: locating source', {
        sourceKind, sourceFavId, sourceFolderId,
        sourceOriginalIdx, targetPosition: target.position,
        topLevelSummary: topLevel.map(it => it.kind === 'folder' ? `F${it.folder.id}` : `C${it.fav.id}`)
      });
      // No-op: source is already at the target position (dropped on
      // its own neighbouring separator).
      if (sourceOriginalIdx === target.position || sourceOriginalIdx + 1 === target.position) {
        dlog('separator drop: NO-OP (source already at target position)', {
          sourceOriginalIdx, targetPosition: target.position
        });
        return;
      }

      const flat = topLevel
        .filter((it) => {
          if (sourceKind === 'folder') return !(it.kind === 'folder' && it.folder.id === sourceFolderId);
          return !(it.kind === 'chip' && it.fav.id === sourceFavId);
        })
        .map((it) => it.kind === 'folder'
          ? { kind: 'folder', id: it.folder.id }
          : { kind: 'chip', id: it.fav.id }
        );

      // Off-by-one: separator idx=N means "before original item N".
      // After filtering the source out, every original item after the
      // source shifts left by one. So if the source was BEFORE the
      // target, the target shifts left too.
      let adjustedTarget = target.position;
      if (sourceOriginalIdx >= 0 && sourceOriginalIdx < target.position) {
        adjustedTarget = target.position - 1;
      }
      const insertAt = Math.max(0, Math.min(adjustedTarget, flat.length));

      const sourceItem = sourceKind === 'folder'
        ? { kind: 'folder', id: sourceFolderId }
        : { kind: 'chip', id: sourceFavId };
      flat.splice(insertAt, 0, sourceItem);
      dlog('separator drop: calling onReorderTopLevel', { adjustedTarget, insertAt, flat });
      const result = await onReorderTopLevel(flat);
      dlog('separator drop: onReorderTopLevel result', { result });
      return;
    }

    // Chip source only past this point.
    if (sourceKind !== 'chip') return;

    // No-op drops
    if (target.kind === 'chip' && target.favId === sourceFavId) return;

    // Drop chip onto another chip → create a new folder.
    if (target.kind === 'chip') {
      if (!onCreateFolder) return;
      const sourceFav = favorites.find((f) => f.id === sourceFavId);
      const targetFav = favorites.find((f) => f.id === target.favId);
      if (!sourceFav || !targetFav) return;
      const defaultName = targetFav.name || sourceFav.name || 'Group';
      const newFolderId = await onCreateFolder({
        name: defaultName,
        memberIds: [target.favId, sourceFavId]
      });
      if (newFolderId != null) {
        setPendingRenameId(newFolderId);
        setFlashFolderId(newFolderId);
        setTimeout(() => setFlashFolderId(null), 350);
      }
      return;
    }

    // Drop chip onto an existing folder → move into it.
    if (target.kind === 'folder') {
      if (!onMoveFavorite) return;
      await onMoveFavorite(sourceFavId, { folderId: target.folderId, position: -1 });
      setFlashFolderId(target.folderId);
      setTimeout(() => setFlashFolderId(null), 350);
      return;
    }

    // Drop on strip background, coming FROM a folder → remove.
    if (target.kind === 'strip-background' && fromFolderId != null) {
      if (!onMoveFavorite) return;
      await onMoveFavorite(sourceFavId, { folderId: null, position: -1 });
      return;
    }
  }, [drag, favorites, topLevel, onCreateFolder, onMoveFavorite, onReorderTopLevel]);

  // Strip-level drop zone catches "drag-from-popover, drop on rail"
  // = remove from folder. We attach handlers to the rail container.
  const onStripDragOver = (e) => {
    if (!drag || drag.fromFolderId == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const onStripDrop = (e) => {
    if (!drag) return;
    const payload = decodeDrag(e);
    if (!payload || payload.fromFolderId == null) return;
    e.preventDefault();
    handleDrop({ kind: 'strip-background' });
  };

  const scrollBy = (dir) => {
    const el = railRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(220, el.clientWidth * 0.6), behavior: 'smooth' });
  };

  // ── Empty state ───────────────────────────────────────────────────
  if (favorites.length === 0 && folders.length === 0) {
    return <EmptyHint />;
  }

  // The folder currently in the popover (or null).
  const openFolder = topLevel.find(
    (it) => it.kind === 'folder' && it.folder.id === openFolderId
  );

  return (
    <div className="relative h-full flex items-stretch">
      {/* Optional count label slot — wire from MultiViewTopBar if you
          want this to live inside the strip; otherwise the topbar's
          own "PRESETS · NN" can read from the same favorites/folders
          arrays and stay consistent. */}

      {canScrollLeft && (
        <ScrollEdge dir={-1} onClick={() => scrollBy(-1)} anyDragging={!!drag} />
      )}
      {canScrollRight && (
        <ScrollEdge dir={+1} onClick={() => scrollBy(+1)} anyDragging={!!drag} />
      )}

      <div
        ref={railRef}
        onDragOver={onStripDragOver}
        onDrop={onStripDrop}
        className="flex items-stretch overflow-x-auto pr-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden snap-x"
        style={{ scrollPaddingLeft: '0.5rem', scrollPaddingRight: '0.5rem' }}
      >
        {topLevel.map((item, idx) => {
          const sepBefore = (
            <DropSeparator
              key={`sep-${idx}`}
              position={idx}
              isEdge={idx === 0}
              isActive={!!drag}
              isHovered={
                drag && drag.overKind === 'separator' &&
                drag.overTargetId === idx
              }
              onDragEnter={() =>
                setDrag((d) => d && { ...d, overTargetId: idx, overKind: 'separator', intent: 'reorder' })
              }
              onDragLeave={() =>
                setDrag((d) => d && (d.overTargetId === idx && d.overKind === 'separator' ? { ...d, overTargetId: null, overKind: null, intent: null } : d))
              }
              onDrop={() => {
                dlog('SEPARATOR drop', { position: idx, sourceKind: drag?.sourceKind });
                handleDrop({ kind: 'separator', position: idx });
              }}
            />
          );

          if (item.kind === 'folder') {
            const isDragSourceFolder = drag && drag.sourceKind === 'folder' && drag.sourceFolderId === item.folder.id;
            return (
              <React.Fragment key={`fld-${item.folder.id}`}>
                {sepBefore}
                <FolderChip
                  folder={item.folder}
                  children={item.children}
                  isOpen={openFolderId === item.folder.id}
                  isRenamePending={pendingRenameId === item.folder.id}
                  isFlashing={flashFolderId === item.folder.id}
                  isDragHovered={
                    drag &&
                    drag.overKind === 'folder' &&
                    drag.overTargetId === item.folder.id
                  }
                  isDragSource={isDragSourceFolder}
                  anyDragging={!!drag}
                  onToggleOpen={() =>
                    setOpenFolderId((cur) => (cur === item.folder.id ? null : item.folder.id))
                  }
                  onCommitRename={async (newName) => {
                    setPendingRenameId(null);
                    if (newName && onRenameFolder && newName !== item.folder.name) {
                      await onRenameFolder(item.folder.id, newName);
                    }
                  }}
                  onCancelRename={() => setPendingRenameId(null)}
                  onRequestRename={() => setPendingRenameId(item.folder.id)}
                  onPlayFirstChild={async () => {
                    const sorted = [...item.children].sort((a, b) => {
                      const ta = a.lastPlayedAt ? new Date(a.lastPlayedAt).getTime() : 0;
                      const tb = b.lastPlayedAt ? new Date(b.lastPlayedAt).getTime() : 0;
                      return tb - ta;
                    });
                    if (sorted[0]) handlePlay(sorted[0]);
                  }}
                  onDragStart={(e) => {
                    dlog('FOLDER dragstart', { folderId: item.folder.id, name: item.folder.name });
                    // Folder is now draggable for reorder.
                    const payload = { kind: 'folder', folderId: item.folder.id };
                    e.dataTransfer.setData(DT_MIME, encodeDrag(payload));
                    e.dataTransfer.setData('text/plain', encodeDrag(payload));
                    e.dataTransfer.effectAllowed = 'move';
                    setDrag({
                      sourceKind: 'folder',
                      sourceFolderId: item.folder.id,
                      sourceFavId: null,
                      fromFolderId: null,
                      overTargetId: null,
                      overKind: null,
                      intent: null
                    });
                    setOpenFolderId(null);
                  }}
                  onDragEnd={() => {
                    dlog('FOLDER dragend', { folderId: item.folder.id });
                    setDrag(null);
                  }}
                  onDragEnterTarget={() =>
                    setDrag((d) => {
                      if (!d) return d;
                      // Folder→folder is a REORDER, not a merge.
                      if (d.sourceKind === 'folder') {
                        return { ...d, overTargetId: idx, overKind: 'separator', intent: 'reorder' };
                      }
                      return { ...d, overTargetId: item.folder.id, overKind: 'folder', intent: 'add-to-folder' };
                    })
                  }
                  onDragLeaveTarget={() =>
                    setDrag((d) => {
                      if (!d) return d;
                      if (d.sourceKind === 'folder' && d.overTargetId === idx && d.overKind === 'separator') {
                        return { ...d, overTargetId: null, overKind: null, intent: null };
                      }
                      if (d.overTargetId === item.folder.id) {
                        return { ...d, overTargetId: null, overKind: null, intent: null };
                      }
                      return d;
                    })
                  }
                  onDropTarget={() => {
                    dlog('FOLDER drop target', { targetFolderId: item.folder.id, idx, sourceKind: drag?.sourceKind });
                    if (drag && drag.sourceKind === 'folder') {
                      handleDrop({ kind: 'separator', position: idx });
                      return;
                    }
                    handleDrop({ kind: 'folder', folderId: item.folder.id });
                  }}
                />
              </React.Fragment>
            );
          }
          // Top-level chip
          const fav = item.fav;
          const key = `${fav.sourceId}::${fav.channelId}`;
          const slot = liveSlots.get(key);
          const isLive = slot != null;
          const isPlaying = playingKey === key;
          const isRemoving = removingId === fav.id;
          const isDragSource = drag && drag.sourceFavId === fav.id;
          const isDragHovered =
            drag &&
            drag.overKind === 'chip' &&
            drag.overTargetId === fav.id;
          return (
            <React.Fragment key={`chip-${fav.id}`}>
              {sepBefore}
              <Chip
                fav={fav}
                isLive={isLive}
                tileSlot={slot}
                isPlaying={isPlaying}
                isRemoving={isRemoving}
                isDragSource={isDragSource}
                isDragHovered={isDragHovered}
                anyDragging={!!drag}
                railClass={railFor(fav.sourceType)}
                subtitle={subtitleFor(fav)}
                host={hostOf(fav.sourceUrl)}
                onPlay={() => handlePlay(fav)}
                onRemove={() => handleRemove(fav)}
                onDragStart={(e) => {
                  const payload = { kind: 'chip', favId: fav.id, fromFolderId: null };
                  e.dataTransfer.setData(DT_MIME, encodeDrag(payload));
                  e.dataTransfer.setData('text/plain', encodeDrag(payload));
                  e.dataTransfer.effectAllowed = 'move';
                  setDrag({
                    sourceKind: 'chip',
                    sourceFavId: fav.id,
                    sourceFolderId: null,
                    fromFolderId: null,
                    overTargetId: null,
                    overKind: null,
                    intent: null
                  });
                }}
                onDragEnd={() => setDrag(null)}
                onDragEnterTarget={() =>
                  setDrag((d) => {
                    if (!d) return d;
                    // Folder→chip is a REORDER (insert before chip).
                    // Surface a "separator-style" indicator at this
                    // chip's leading edge rather than a merge halo.
                    if (d.sourceKind === 'folder') {
                      return { ...d, overTargetId: idx, overKind: 'separator', intent: 'reorder' };
                    }
                    if (d.sourceFavId === fav.id) return d;
                    return { ...d, overTargetId: fav.id, overKind: 'chip', intent: 'create-folder' };
                  })
                }
                onDragLeaveTarget={() =>
                  setDrag((d) => {
                    if (!d) return d;
                    if (d.sourceKind === 'folder' && d.overTargetId === idx && d.overKind === 'separator') {
                      return { ...d, overTargetId: null, overKind: null, intent: null };
                    }
                    if (d.overTargetId === fav.id) {
                      return { ...d, overTargetId: null, overKind: null, intent: null };
                    }
                    return d;
                  })
                }
                onDropTarget={() => {
                  dlog('CHIP drop target', { targetFavId: fav.id, idx, sourceKind: drag?.sourceKind });
                  if (drag && drag.sourceKind === 'folder') {
                    handleDrop({ kind: 'separator', position: idx });
                    return;
                  }
                  handleDrop({ kind: 'chip', favId: fav.id });
                }}
              />
            </React.Fragment>
          );
        })}
        {/* Trailing separator after the last item — lets users drop
            at the very end of the rail. */}
        <DropSeparator
          key="sep-end"
          position={topLevel.length}
          isEdge
          isActive={!!drag}
          isHovered={
            drag && drag.overKind === 'separator' &&
            drag.overTargetId === topLevel.length
          }
          onDragEnter={() =>
            setDrag((d) => d && { ...d, overTargetId: topLevel.length, overKind: 'separator', intent: 'reorder' })
          }
          onDragLeave={() =>
            setDrag((d) => d && (d.overTargetId === topLevel.length && d.overKind === 'separator' ? { ...d, overTargetId: null, overKind: null, intent: null } : d))
          }
          onDrop={() => {
            dlog('SEPARATOR drop (end)', { position: topLevel.length, sourceKind: drag?.sourceKind });
            handleDrop({ kind: 'separator', position: topLevel.length });
          }}
        />
      </div>

      {openFolder && (
        <FolderPopover
          folder={openFolder.folder}
          children={openFolder.children}
          liveSlots={liveSlots}
          playingKey={playingKey}
          removingId={removingId}
          drag={drag}
          railFor={railFor}
          subtitleFor={subtitleFor}
          hostOf={hostOf}
          onClose={() => setOpenFolderId(null)}
          onPlayChild={handlePlay}
          onRemoveChild={handleRemove}
          onRenameFolder={async (name) => {
            if (onRenameFolder) await onRenameFolder(openFolder.folder.id, name);
          }}
          onDeleteFolder={async () => {
            setOpenFolderId(null);
            if (onDeleteFolder) await onDeleteFolder(openFolder.folder.id);
          }}
          onMoveOutOfFolder={async (favId) => {
            if (onMoveFavorite) await onMoveFavorite(favId, { folderId: null, position: -1 });
          }}
          onChildDragStart={(e, fav) => {
            const payload = { kind: 'chip', favId: fav.id, fromFolderId: openFolder.folder.id };
            e.dataTransfer.setData(DT_MIME, encodeDrag(payload));
            e.dataTransfer.setData('text/plain', encodeDrag(payload));
            e.dataTransfer.effectAllowed = 'move';
            setDrag({
              sourceKind: 'chip',
              sourceFavId: fav.id,
              sourceFolderId: null,
              fromFolderId: openFolder.folder.id,
              overTargetId: null,
              overKind: null,
              intent: 'leave-folder'
            });
            dlog('POPOVER child dragstart', { favId: fav.id, fromFolderId: openFolder.folder.id });
          }}
          onChildDragEnd={() => setDrag(null)}
        />
      )}
    </div>
  );
};

// ─── Chip (top-level preset) ──────────────────────────────────────────

const Chip = React.forwardRef(function Chip({
  fav,
  isLive, tileSlot,
  isPlaying, isRemoving,
  isDragSource, isDragHovered, anyDragging,
  railClass, subtitle, host,
  onPlay, onRemove,
  onDragStart, onDragEnd,
  onDragEnterTarget, onDragLeaveTarget, onDropTarget,
  draggable = true
}, ref) {
  const disabled = isPlaying || isRemoving;
  const enterDepth = useRef(0);

  const tooltip = isLive
    ? `Playing in tile ${tileSlot} · ${subtitle}${host ? ` · ${host}` : ''}`
    : `Play ${fav.name} · ${subtitle}${host ? ` · ${host}` : ''} · drag onto another preset to group`;

  // dragenter/leave bubble — track depth so leaving a child doesn't
  // unhighlight while still inside the chip.
  const handleDragEnter = (e) => {
    if (!anyDragging) return;
    e.preventDefault();
    enterDepth.current += 1;
    if (enterDepth.current === 1) onDragEnterTarget?.(e);
  };
  const handleDragLeave = (e) => {
    if (!anyDragging) return;
    enterDepth.current = Math.max(0, enterDepth.current - 1);
    if (enterDepth.current === 0) onDragLeaveTarget?.(e);
  };
  const handleDragOver = (e) => {
    if (!anyDragging) return;
    e.preventDefault(); // required for drop to fire
    e.dataTransfer.dropEffect = 'move';
  };
  const handleDrop = (e) => {
    if (!anyDragging) return;
    e.preventDefault();
    e.stopPropagation();
    enterDepth.current = 0;
    onDropTarget?.(e);
  };

  return (
    <button
      ref={ref}
      type="button"
      // Guard click in JS rather than via the `disabled` attribute —
      // a disabled <button> doesn't fire drop events in Chrome, which
      // means dragging a folder over a live chip would silently
      // cancel instead of reordering. We still want the chip to be a
      // valid drop target (for folder reorder + chip merge), so the
      // attribute stays off and we no-op the click for live chips.
      onClick={() => { if (!isLive && !disabled) onPlay?.(); }}
      aria-disabled={disabled || isLive || undefined}
      title={tooltip}
      // Drag is allowed even when the chip is currently live in a
      // tile — re-organising into a folder doesn't change playback
      // state. Only block while a mutation is in flight.
      draggable={draggable && !disabled}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={[
        // Base
        'group/chip relative flex-shrink-0 h-full snap-start inline-flex items-center gap-1.5 px-1.5',
        'overflow-hidden rounded-md text-left',
        'transition-[transform,background-color,box-shadow,opacity] duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]',
        // State styles
        isLive
          ? 'bg-emerald-500/[0.08] ring-1 ring-emerald-500/30 cursor-default'
          : isPlaying
          ? 'bg-amber-500/[0.10] ring-1 ring-amber-400/40 cursor-wait'
          : isRemoving
          ? 'opacity-40 cursor-not-allowed'
          : 'bg-slate-900/70 ring-1 ring-slate-800/80 hover:ring-amber-500/30 hover:bg-slate-900 hover:-translate-y-px',
        // Drag source: ghosted in place
        isDragSource && 'opacity-30',
        // Drag hovered: amber outline + faint amber wash
        isDragHovered && '!ring-amber-400/70 !bg-amber-500/[0.12] scale-[1.02]',
        // Dim other chips while a drag is in flight to focus attention
        anyDragging && !isDragSource && !isDragHovered && 'opacity-60'
      ].filter(Boolean).join(' ')}
      style={{ maxWidth: '180px', minWidth: '96px' }}
    >
      {/* Source-color rail */}
      <span
        aria-hidden
        className={`relative w-[2px] flex-shrink-0 self-stretch -ml-1.5 bg-gradient-to-b ${
          isLive
            ? 'from-emerald-300 to-emerald-500'
            : isPlaying
            ? 'from-amber-300 to-amber-500'
            : isDragHovered
            ? 'from-amber-300 to-amber-500'
            : `${railClass} opacity-60 group-hover/chip:opacity-100`
        } transition-opacity duration-150`}
      />

      {/* Logo */}
      <div className="relative flex-shrink-0 w-4 h-4 rounded-sm overflow-hidden bg-slate-800 ring-1 ring-slate-700/60">
        {fav.logo ? (
          <img
            src={fav.logo}
            alt=""
            className="w-full h-full object-contain"
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
            draggable={false}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-slate-500 font-mono text-[7px] uppercase">
            {(fav.name?.[0] || '?').toUpperCase()}
          </div>
        )}
      </div>

      {/* Name */}
      <span className="text-[11px] font-semibold text-slate-100 truncate min-w-0 flex-shrink leading-none">
        {fav.name}
      </span>

      {/* Drag-hover "merge into folder" hint — appears in place of
          the play icon when a drag is hovering this chip. */}
      {isDragHovered ? (
        <span className="flex-shrink-0 inline-flex items-center gap-0.5 px-1 py-px rounded text-[8.5px] font-bold uppercase tracking-[0.14em] text-amber-200 leading-none font-mono">
          + GRP
        </span>
      ) : isLive ? (
        <span className="flex-shrink-0 inline-flex items-center gap-0.5 px-1 py-px rounded text-[8.5px] font-bold uppercase tracking-[0.12em] text-emerald-200 border border-emerald-500/30 bg-emerald-500/10 leading-none font-mono">
          #{tileSlot}
        </span>
      ) : isPlaying ? (
        <svg className="flex-shrink-0 w-2.5 h-2.5 animate-spin text-amber-300" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : (
        <svg
          className="flex-shrink-0 w-3 h-3 text-amber-300/70 group-hover/chip:text-amber-200 transition-colors"
          fill="currentColor" viewBox="0 0 24 24"
          aria-hidden
        >
          <path d="M8 5v14l11-7z" />
        </svg>
      )}

      {/* Remove "x" — only on hover, only when not live & not dragging */}
      {!isLive && !anyDragging && (
        <span
          role="button"
          tabIndex={-1}
          onClick={(e) => { e.stopPropagation(); onRemove?.(); }}
          onMouseDown={(e) => e.stopPropagation()}
          className="absolute top-0 right-0 opacity-0 group-hover/chip:opacity-100 transition flex items-center justify-center w-3.5 h-3.5 rounded-bl-md bg-slate-950/90 text-slate-500 hover:text-rose-300"
          title="Remove from presets"
        >
          <svg className="w-2 h-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </span>
      )}
    </button>
  );
});

// ─── FolderChip ───────────────────────────────────────────────────────
//
// Aesthetic: literal stacked cards. Two offset shadow layers behind the
// chip, no rounded blob, no fancy logo grid — the back layers ARE the
// "this is a stack" cue. Count badge is mono in brackets like `[ 04 ]`.

const FolderChip = ({
  folder,
  children: members,
  isOpen,
  isRenamePending,
  isFlashing,
  isDragHovered,
  isDragSource,
  anyDragging,
  onToggleOpen,
  onCommitRename,
  onCancelRename,
  onRequestRename,
  onPlayFirstChild,
  onDragStart,
  onDragEnd,
  onDragEnterTarget,
  onDragLeaveTarget,
  onDropTarget
}) => {
  const enterDepth = useRef(0);

  // Determine rail color: single-source folders inherit, mixed = amber.
  const sourceTypes = useMemo(
    () => new Set(members.map((m) => m.sourceType)),
    [members]
  );
  const uniformSourceType = sourceTypes.size === 1 ? [...sourceTypes][0] : null;
  const railClass = uniformSourceType
    ? railFor(uniformSourceType)
    : 'from-amber-300 to-amber-500';

  // Primary logo: first child's. Folder badge is the count.
  const primaryLogo = members[0]?.logo;
  const primaryFallback = (members[0]?.name?.[0] || folder.name?.[0] || '·').toUpperCase();
  const count = members.length;

  const handleDragEnter = (e) => {
    if (!anyDragging) return;
    e.preventDefault();
    enterDepth.current += 1;
    if (enterDepth.current === 1) onDragEnterTarget?.(e);
  };
  const handleDragLeave = (e) => {
    if (!anyDragging) return;
    enterDepth.current = Math.max(0, enterDepth.current - 1);
    if (enterDepth.current === 0) onDragLeaveTarget?.(e);
  };
  const handleDragOver = (e) => {
    if (!anyDragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const handleDrop = (e) => {
    if (!anyDragging) return;
    e.preventDefault();
    e.stopPropagation();
    enterDepth.current = 0;
    onDropTarget?.(e);
  };

  const tooltip = `${folder.name} — ${count} channel${count === 1 ? '' : 's'} · click to play first · ⌄ to expand`;

  return (
    <div
      data-folder-chip-id={folder.id}
      // The wrapper is the drag source. Dragging from anywhere inside
      // (body button or chevron) initiates folder reorder. Plain
      // clicks still work because HTML5 DnD only kicks in after ~3px
      // of movement, below which the click event still fires.
      draggable={!isRenamePending && !anyDragging || isDragSource}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={[
        'group/folder relative flex-shrink-0 h-full snap-start',
        'transition-opacity duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]',
        isDragSource && 'opacity-30'
      ].filter(Boolean).join(' ')}
      style={{ minWidth: '128px', maxWidth: '200px' }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Stacked-card shadows — two layers peeking behind the chip.
          These are the visual signal "this is a stack". */}
      <span
        aria-hidden
        className="absolute inset-0 rounded-md bg-slate-900/40 ring-1 ring-slate-800/70 pointer-events-none"
        style={{ transform: 'translate(3px, 1px)', zIndex: 0 }}
      />
      <span
        aria-hidden
        className="absolute inset-0 rounded-md bg-slate-900/55 ring-1 ring-slate-800/80 pointer-events-none"
        style={{ transform: 'translate(1.5px, 0.5px)', zIndex: 0 }}
      />

      {/* Front chip — flex with play surface (left) + chevron (right) */}
      <div
        className={[
          'relative h-full flex items-stretch rounded-md overflow-hidden',
          'transition-[transform,background-color,box-shadow,opacity] duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]',
          isDragHovered
            ? 'bg-amber-500/[0.10] ring-1 ring-amber-400/70 scale-[1.02]'
            : isOpen
            ? 'bg-slate-900 ring-1 ring-amber-400/40 -translate-y-px'
            : 'bg-slate-900/85 ring-1 ring-slate-800/80 hover:ring-amber-500/30 hover:bg-slate-900 hover:-translate-y-px',
          anyDragging && !isDragHovered && 'opacity-60'
        ].filter(Boolean).join(' ')}
        style={{
          zIndex: 1,
          animation: isFlashing
            ? 'favstrip-merge-flash 350ms cubic-bezier(0.4,0,0.2,1)'
            : isDragHovered
            ? 'favstrip-folder-glow 1s cubic-bezier(0.4,0,0.2,1) infinite'
            : undefined
        }}
      >
        {/* Source-color rail */}
        <span
          aria-hidden
          className={`relative w-[2px] flex-shrink-0 self-stretch bg-gradient-to-b ${
            isOpen || isDragHovered
              ? 'from-amber-300 to-amber-500'
              : `${railClass} opacity-70 group-hover/folder:opacity-100`
          } transition-opacity duration-150`}
        />

        {/* Body — play target */}
        <button
          type="button"
          onClick={onPlayFirstChild}
          title={tooltip}
          className="flex-1 min-w-0 inline-flex items-center gap-1.5 px-1.5 text-left"
        >
          {/* Logo (with a tiny corner notch indicating stack) */}
          <div className="relative flex-shrink-0 w-4 h-4 rounded-sm overflow-hidden bg-slate-800 ring-1 ring-slate-700/60">
            {primaryLogo ? (
              <img
                src={primaryLogo}
                alt=""
                className="w-full h-full object-contain"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
                draggable={false}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-slate-500 font-mono text-[7px] uppercase">
                {primaryFallback}
              </div>
            )}
            {/* Stack-corner notch — tiny amber slash on top-right */}
            <span
              aria-hidden
              className="absolute top-0 right-0 w-[5px] h-[5px] bg-amber-400/80"
              style={{ clipPath: 'polygon(100% 0, 100% 100%, 0 0)' }}
            />
          </div>

          {/* Name (or inline rename input) */}
          {isRenamePending ? (
            <FolderRenameInput
              initial={folder.name}
              onCommit={onCommitRename}
              onCancel={onCancelRename}
            />
          ) : (
            <span
              className="text-[11px] font-semibold text-slate-100 truncate min-w-0 flex-shrink leading-none"
              onDoubleClick={(e) => { e.stopPropagation(); onRequestRename?.(); }}
            >
              {folder.name}
            </span>
          )}

          {/* Drag-hover hint — replaces the count when something can be merged */}
          {isDragHovered ? (
            <span className="flex-shrink-0 inline-flex items-center px-1 py-px rounded text-[8.5px] font-bold uppercase tracking-[0.16em] text-amber-200 leading-none font-mono">
              + ADD
            </span>
          ) : (
            <span
              className="flex-shrink-0 font-mono text-[9.5px] tabular-nums tracking-[0.08em] text-amber-200/85 leading-none"
              title={`${count} channel${count === 1 ? '' : 's'} in this preset`}
            >
              [&nbsp;{String(count).padStart(2, '0')}&nbsp;]
            </span>
          )}
        </button>

        {/* Chevron — separate click target, opens popover */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleOpen?.(); }}
          title={isOpen ? 'Close folder' : 'Expand folder'}
          className={[
            'flex-shrink-0 inline-flex items-center justify-center w-5 h-full border-l',
            'transition-colors duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]',
            isOpen
              ? 'border-amber-500/30 text-amber-200 bg-amber-500/[0.08]'
              : 'border-slate-800/80 text-slate-400 hover:text-amber-200 hover:bg-slate-800/60'
          ].join(' ')}
        >
          <svg
            className={`w-3 h-3 transition-transform duration-150 ${isOpen ? 'rotate-180' : ''}`}
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>
    </div>
  );
};

// ─── FolderRenameInput ────────────────────────────────────────────────

const FolderRenameInput = ({ initial, onCommit, onCancel }) => {
  const inputRef = useRef(null);
  const [value, setValue] = useState(initial || '');

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    // Defer focus so the input is fully mounted before we yank focus
    // away from the chip's button (which fired the rename request).
    const t = requestAnimationFrame(() => {
      el.focus();
      el.select();
    });
    return () => cancelAnimationFrame(t);
  }, []);

  const commit = () => {
    const trimmed = value.trim().slice(0, 60);
    if (trimmed) onCommit?.(trimmed);
    else onCancel?.();
  };

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); onCancel?.(); }
      }}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      maxLength={60}
      className="min-w-0 flex-1 bg-slate-950/60 ring-1 ring-amber-400/50 rounded-sm px-1 text-[11px] font-semibold text-amber-100 leading-none caret-amber-300 focus:outline-none focus:ring-amber-400 placeholder:text-slate-600"
      style={{ fontFamily: 'inherit' }}
    />
  );
};

// ─── FolderPopover ────────────────────────────────────────────────────
//
// A "docked drawer" rather than a floating tooltip. Anchored beneath
// the folder chip via position:fixed (so it can escape the strip's
// horizontal scroll overflow). Sharp notch on top points at the chip.

const FolderPopover = ({
  folder,
  children: members,
  liveSlots,
  playingKey,
  removingId,
  drag,
  railFor: railForFn,
  subtitleFor: subtitleForFn,
  hostOf: hostOfFn,
  onClose,
  onPlayChild,
  onRemoveChild,
  onRenameFolder,
  onDeleteFolder,
  onMoveOutOfFolder,
  onChildDragStart,
  onChildDragEnd
}) => {
  const popoverRef = useRef(null);
  const [renaming, setRenaming] = useState(false);
  const [position, setPosition] = useState(null);

  // Anchor the popover under the folder chip itself. If the chip
  // isn't found (shouldn't happen, but guard anyway), fall back to
  // the rail. position:fixed lets us escape the strip's horizontal
  // overflow container, so we can paint wherever we want.
  useLayoutEffect(() => {
    const calc = () => {
      const chipEl = document.querySelector(`[data-folder-chip-id="${folder.id}"]`);
      const railEl = document.querySelector('[data-favstrip-rail]');
      const anchor = chipEl || railEl || document.body;
      const rect = anchor.getBoundingClientRect();
      const popWidth = 360;
      // Prefer to anchor the popover's LEFT edge under the chip's left
      // edge; clamp to the viewport so it never paints off-screen.
      const desiredLeft = rect.left;
      const clampedLeft = Math.max(
        8,
        Math.min(desiredLeft, window.innerWidth - popWidth - 8)
      );
      setPosition({ top: rect.bottom + 6, left: clampedLeft });
    };
    calc();
    window.addEventListener('resize', calc);
    window.addEventListener('scroll', calc, true);
    return () => {
      window.removeEventListener('resize', calc);
      window.removeEventListener('scroll', calc, true);
    };
  }, [folder.id]);

  // Click outside + Escape closes the popover.
  useEffect(() => {
    const handleDown = (e) => {
      if (!popoverRef.current) return;
      // Don't dismiss if the click landed on the folder chip itself
      // (the chip's chevron toggles the same state and would race).
      if (popoverRef.current.contains(e.target)) return;
      if (e.target.closest('[data-folder-chip-id]')) return;
      onClose?.();
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  if (!position) return null;

  // Portal to document.body so the popover escapes any ancestor that
  // creates a stacking context (transforms, filters, backdrop-blur on
  // the top bar all do). Without the portal, the tile overlays paint
  // over the popover even with z-[2000].
  const content = (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={`${folder.name} preset folder`}
      className="fixed z-[2000] w-[360px] rounded-lg bg-slate-950/95 ring-1 ring-amber-500/25 shadow-[0_18px_42px_-12px_rgba(0,0,0,0.7),0_0_0_1px_rgba(15,23,42,0.6)] backdrop-blur-sm overflow-hidden"
      style={{
        top: position.top,
        left: position.left,
        animation: 'favstrip-popover-in 180ms cubic-bezier(0.4,0,0.2,1)'
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-slate-800/80 bg-slate-900/60">
        {/* Folder marker — small bracketed glyph */}
        <span className="font-mono text-[9.5px] uppercase tracking-[0.22em] text-amber-300/80">
          [GRP]
        </span>
        {/* Name (editable) */}
        {renaming ? (
          <FolderRenameInput
            initial={folder.name}
            onCommit={async (n) => { setRenaming(false); await onRenameFolder?.(n); }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setRenaming(true)}
            className="flex-1 min-w-0 truncate text-left text-[12px] font-semibold text-slate-100 hover:text-amber-100 transition-colors"
            title="Click to rename"
          >
            {folder.name}
          </button>
        )}
        {/* Count */}
        <span className="font-mono text-[10px] tabular-nums tracking-[0.12em] text-amber-200/85">
          {String(members.length).padStart(2, '0')}
          <span className="text-slate-600 ml-1">CH</span>
        </span>
        {/* Delete */}
        <button
          type="button"
          onClick={async () => {
            if (members.length > 0 && !window.confirm(`Delete folder "${folder.name}"? Its ${members.length} preset${members.length === 1 ? '' : 's'} will return to the strip.`)) return;
            await onDeleteFolder?.();
          }}
          className="ml-1 flex-shrink-0 inline-flex items-center justify-center w-5 h-5 rounded text-slate-500 hover:text-rose-300 hover:bg-rose-500/10 transition"
          title="Delete folder (presets keep, ungroup)"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z" />
          </svg>
        </button>
        {/* Close */}
        <button
          type="button"
          onClick={onClose}
          className="flex-shrink-0 inline-flex items-center justify-center w-5 h-5 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition"
          title="Close"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Body — child list */}
      {members.length === 0 ? (
        <div className="px-3 py-6 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-slate-600">
          No channels in this folder
        </div>
      ) : (
        <ul className="max-h-[360px] overflow-y-auto py-1 [scrollbar-width:thin]">
          {members.map((fav) => {
            const key = `${fav.sourceId}::${fav.channelId}`;
            const slot = liveSlots.get(key);
            const isLive = slot != null;
            const isPlaying = playingKey === key;
            const isRemoving = removingId === fav.id;
            const isDragSource = drag && drag.sourceFavId === fav.id;
            return (
              <PopoverRow
                key={fav.id}
                fav={fav}
                isLive={isLive}
                tileSlot={slot}
                isPlaying={isPlaying}
                isRemoving={isRemoving}
                isDragSource={isDragSource}
                railClass={railForFn(fav.sourceType)}
                subtitle={subtitleForFn(fav)}
                host={hostOfFn(fav.sourceUrl)}
                onPlay={() => onPlayChild?.(fav)}
                onRemove={() => onRemoveChild?.(fav)}
                onMoveOut={() => onMoveOutOfFolder?.(fav.id)}
                onDragStart={(e) => onChildDragStart?.(e, fav)}
                onDragEnd={onChildDragEnd}
              />
            );
          })}
        </ul>
      )}

      {/* Footer hint */}
      <div className="flex items-center justify-between gap-2 px-3 h-7 border-t border-slate-800/80 bg-slate-900/40 font-mono text-[9px] uppercase tracking-[0.16em] text-slate-600">
        <span>Drag row → rail to remove from folder</span>
        <span className="tabular-nums text-slate-700">
          Esc · close
        </span>
      </div>
    </div>
  );
  return typeof document !== 'undefined'
    ? createPortal(content, document.body)
    : content;
};

// ─── PopoverRow — child chip rendered inside the folder popover ──────

const PopoverRow = ({
  fav,
  isLive, tileSlot,
  isPlaying, isRemoving, isDragSource,
  railClass, subtitle, host,
  onPlay, onRemove, onMoveOut,
  onDragStart, onDragEnd
}) => {
  const disabled = isPlaying || isRemoving;
  return (
    <li>
      <div
        className={[
          'group/row relative flex items-center gap-2 mx-1 px-2 h-8 rounded-md',
          'transition-[background-color,box-shadow,opacity] duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]',
          isLive
            ? 'bg-emerald-500/[0.07] ring-1 ring-emerald-500/25'
            : isPlaying
            ? 'bg-amber-500/[0.10] ring-1 ring-amber-400/35'
            : 'bg-slate-900/40 hover:bg-slate-900/80 ring-1 ring-transparent hover:ring-slate-800',
          isDragSource && 'opacity-30'
        ].filter(Boolean).join(' ')}
        draggable={!isLive && !disabled}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        {/* Source rail */}
        <span
          aria-hidden
          className={`w-[2px] h-full flex-shrink-0 -ml-2 bg-gradient-to-b ${
            isLive
              ? 'from-emerald-300 to-emerald-500'
              : isPlaying
              ? 'from-amber-300 to-amber-500'
              : `${railClass} opacity-70 group-hover/row:opacity-100`
          } transition-opacity`}
        />
        {/* Logo */}
        <div className="relative flex-shrink-0 w-5 h-5 rounded-sm overflow-hidden bg-slate-800 ring-1 ring-slate-700/60">
          {fav.logo ? (
            <img
              src={fav.logo}
              alt=""
              className="w-full h-full object-contain"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
              draggable={false}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-slate-500 font-mono text-[8px] uppercase">
              {(fav.name?.[0] || '?').toUpperCase()}
            </div>
          )}
        </div>
        {/* Name + subtitle */}
        <button
          type="button"
          onClick={onPlay}
          disabled={disabled || isLive}
          title={isLive ? `Playing in tile ${tileSlot}` : `Play ${fav.name}`}
          className="flex-1 min-w-0 flex flex-col items-start text-left disabled:cursor-default"
        >
          <span className="text-[11.5px] font-semibold text-slate-100 truncate w-full leading-tight">
            {fav.name}
          </span>
          <span className="font-mono text-[8.5px] uppercase tracking-[0.12em] text-slate-500 truncate w-full leading-tight">
            {subtitle}{host ? ` · ${host}` : ''}
          </span>
        </button>

        {/* Live badge or play affordance */}
        {isLive ? (
          <span className="flex-shrink-0 inline-flex items-center gap-0.5 px-1 py-px rounded text-[8.5px] font-bold uppercase tracking-[0.12em] text-emerald-200 border border-emerald-500/30 bg-emerald-500/10 leading-none font-mono">
            #{tileSlot}
          </span>
        ) : isPlaying ? (
          <svg className="flex-shrink-0 w-3 h-3 animate-spin text-amber-300" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <svg
            className="flex-shrink-0 w-3.5 h-3.5 text-amber-300/70 group-hover/row:text-amber-200 transition-colors"
            fill="currentColor" viewBox="0 0 24 24"
            aria-hidden
          >
            <path d="M8 5v14l11-7z" />
          </svg>
        )}

        {/* Action menu on hover — remove-from-folder + delete */}
        {!isLive && (
          <div className="flex-shrink-0 flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onMoveOut?.(); }}
              className="inline-flex items-center justify-center w-4 h-4 rounded text-slate-500 hover:text-amber-200 hover:bg-amber-500/10"
              title="Move out of folder"
            >
              <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16 17l5-5-5-5M21 12H9M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
              </svg>
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRemove?.(); }}
              className="inline-flex items-center justify-center w-4 h-4 rounded text-slate-500 hover:text-rose-300 hover:bg-rose-500/10"
              title="Remove preset entirely"
            >
              <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </li>
  );
};

// ─── DropSeparator — between every pair of top-level items ───────────
//
// Idle: takes up the same 6px the old `gap-1.5` did, fully invisible.
// During an active drag: widens to 12px and reveals an amber slot line
// when hovered, so the user sees exactly where the dropped item will
// land. Drop = caller-provided handler reorders the top-level list.

const DropSeparator = ({ position, isActive, isHovered, isEdge, onDragEnter, onDragLeave, onDrop }) => {
  const enterDepth = useRef(0);
  const handleEnter = (e) => {
    if (!isActive) return;
    e.preventDefault();
    enterDepth.current += 1;
    if (enterDepth.current === 1) onDragEnter?.();
  };
  const handleLeave = () => {
    if (!isActive) return;
    enterDepth.current = Math.max(0, enterDepth.current - 1);
    if (enterDepth.current === 0) onDragLeave?.();
  };
  const handleOver = (e) => {
    if (!isActive) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const handleDrop = (e) => {
    if (!isActive) return;
    e.preventDefault();
    e.stopPropagation();
    enterDepth.current = 0;
    onDrop?.();
  };

  // Width strategy:
  //   idle           → 6px (matches the original gap-1.5)
  //   active (drag)  → 20px for inner separators, 28px for edges so the
  //                    leftmost and rightmost slots are easy to hit
  //                    without precise aim
  //   isHovered      → +amber line on top of the active width
  const widthClass = !isActive ? 'w-1.5' : isEdge ? 'w-7' : 'w-5';

  return (
    <div
      data-drop-separator-position={position}
      onDragEnter={handleEnter}
      onDragLeave={handleLeave}
      onDragOver={handleOver}
      onDrop={handleDrop}
      className={[
        'relative flex-shrink-0 h-full self-stretch',
        'transition-[width] duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]',
        widthClass
      ].join(' ')}
      aria-hidden={!isActive}
    >
      {/* Drop indicator — vertical amber line, only visible while hovered. */}
      <span
        aria-hidden
        className={[
          'absolute top-1 bottom-1 left-1/2 -translate-x-1/2 rounded',
          'transition-[background-color,box-shadow,width] duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]',
          isHovered
            ? 'w-[2px] bg-amber-300 shadow-[0_0_6px_rgba(251,191,36,0.6)]'
            : isActive
            ? 'w-px bg-slate-700/60'
            : 'w-px bg-transparent'
        ].join(' ')}
      />
    </div>
  );
};

// ─── Sub-components ───────────────────────────────────────────────────

const ScrollEdge = ({ dir, onClick, anyDragging }) => (
  <button
    type="button"
    onClick={onClick}
    // During a drag, become invisible to pointer events so the user
    // can reach the leftmost/rightmost DropSeparator underneath
    // without us absorbing the drop. The button still occupies space
    // visually — we just stop intercepting.
    className={`absolute top-1/2 -translate-y-1/2 z-10 flex h-6 w-5 items-center justify-center bg-slate-950/90 text-slate-400 ring-1 ring-slate-800 hover:text-amber-200 hover:ring-amber-500/30 transition ${
      dir < 0 ? 'left-0 rounded-r-md' : 'right-0 rounded-l-md'
    } ${anyDragging ? 'pointer-events-none opacity-30' : ''}`}
    aria-label={dir < 0 ? 'Scroll presets left' : 'Scroll presets right'}
  >
    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
        d={dir < 0 ? 'M15 19l-7-7 7-7' : 'M9 5l7 7-7 7'}
      />
    </svg>
  </button>
);

const EmptyHint = () => (
  <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.16em] text-slate-600 px-2">
    <svg className="w-3 h-3 text-amber-300/50 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 21s-7.5-4.7-9.6-9.4C1.1 8.4 3.4 5 7 5c2 0 3.8 1.1 5 2.7C13.2 6.1 15 5 17 5c3.6 0 5.9 3.4 4.6 6.6C19.5 16.3 12 21 12 21z" />
    </svg>
    <span>No presets · tap ♥ on any channel to save · drag presets together to group</span>
  </div>
);

// Expose the count helpers for the parent (MultiViewTopBar) to render
// "PRESETS · NN · MM ch" in sync with this strip's grouping logic.
export const computePresetCounts = (favorites, folders) => {
  const top = buildTopLevel(favorites || [], folders || []);
  return {
    topLevelCount: top.length,
    totalChannelCount: (favorites || []).length,
    folderCount: (folders || []).length
  };
};

export default FavoritesStrip;
