# EPG Sources Configuration

## Overview

`epg_sources.json` is the **single source of truth** for EPG sources used by both the Python parser and Node.js backend. This eliminates duplicate source lists and makes it easy to add, remove, or disable sources.

## File Structure

```json
{
  "sources": [
    {
      "url": "https://example.com/epg.xml.gz",
      "name": "Human-readable name",
      "enabled": true,
      "verified": true,
      "notes": "Optional description or status"
    }
  ],
  "metadata": {
    "lastUpdated": "2025-10-30",
    "version": "1.0.0",
    "description": "..."
  }
}
```

## Source Properties

- **url** (required): The EPG source URL
- **name** (required): Display name shown in the UI
- **enabled** (boolean): If `false`, source will be skipped during refresh
- **verified** (boolean): Indicates if the source has been tested and is working
- **notes** (string): Additional information (e.g., why it's disabled, coverage details)

## Usage

### Disabling a Source

If a source becomes unavailable or unreliable, set `enabled: false`:

```json
{
  "url": "https://broken-source.com/epg.xml",
  "name": "Broken Source",
  "enabled": false,
  "verified": false,
  "notes": "Server appears to be permanently down"
}
```

**Effect:**
- Python parser will skip it during refresh
- UI will show it grayed out with a "Disabled" badge
- Source remains in the list for reference

### Adding a New Source

1. Add a new object to the `sources` array:

```json
{
  "url": "https://new-epg.com/guide.xml.gz",
  "name": "New EPG Provider",
  "enabled": true,
  "verified": false,
  "notes": "Newly added - needs verification"
}
```

2. Test it manually first:
```bash
python3 backend/epg_parser.py --source=https://new-epg.com/guide.xml.gz
```

3. If it works, set `verified: true`

### Removing a Source

Simply delete the entire source object from the array. **Note:** This will remove it completely from the UI.

If you want to keep it visible but disabled, use `enabled: false` instead.

## Best Practices

1. **Always test before enabling** - Set `verified: false` for new sources until tested
2. **Document why sources are disabled** - Use the `notes` field to explain
3. **Keep disabled sources** - Don't delete them immediately; they might come back online
4. **Update metadata** - Change `lastUpdated` when making significant changes
5. **Maintain order** - Place most reliable sources first

## Automatic Behavior

- **Python parser** (`epg_parser.py`): Processes only `enabled: true` sources
- **Node.js API** (`/api/epg/:sessionId/sources`): Returns all sources with their status
- **Frontend UI**: Shows all sources, visually distinguishing disabled ones

## Examples

### Working Source
```json
{
  "url": "https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz",
  "name": "EPG Share 01 - All Sources",
  "enabled": true,
  "verified": true,
  "notes": "Comprehensive multi-source EPG feed"
}
```

### Temporarily Disabled Source
```json
{
  "url": "https://epg.starlite.best/utc.xml.gz",
  "name": "Starlite EPG - UTC",
  "enabled": false,
  "verified": false,
  "notes": "Currently unavailable - needs verification"
}
```

### Permanently Dead Source
```json
{
  "url": "https://strongepg.ip-ddns.com/epg/w-8k-epg.xml.gz",
  "name": "Strong EPG - 8K",
  "enabled": false,
  "verified": false,
  "notes": "Currently unavailable - server appears to be down"
}
```

## Validation

Both Python and Node.js will gracefully handle missing or malformed config files:
- Python: Falls back to empty list and logs error
- Node.js: Returns error response with details

Always validate JSON syntax before committing:
```bash
python3 -m json.tool backend/config/epg_sources.json
```

## Related Files

- `backend/epg_parser.py` - Python EPG parser (reads this config)
- `backend/routes/epg.js` - Node.js API routes (reads this config)
- `frontend/src/components/EpgRefreshModal.jsx` - UI display
