# IPTV EPG Matcher

A powerful web application for matching IPTV channels with EPG (Electronic Program Guide) data, with live stream playback capability.

## Overview

IPTV EPG Matcher allows you to:
- Load IPTV channels from various sources (M3U files, URLs, or Xtream API)
- Auto-match or manually match channels with EPG data
- Watch live TV streams directly in your browser
- Generate new Xtream credentials with properly matched EPG data
- Use a high-performance SQLite database for EPG data storage

This tool solves the common problem of mismatched or missing EPG data in IPTV services by providing an intuitive interface to correct and enhance channel metadata.

## Features

- **Multiple Source Support**: Load channels from M3U files, URLs, or Xtream API credentials
- **Automatic EPG Matching**: Smart algorithms to suggest matching EPG IDs for channels
- **Multiple Player Options**: HLS, TS, and VLC link support for maximum compatibility
- **EPG Preview**: View current and upcoming programs for matched channels
- **Channel Filtering**: Browse channels by category or search by name
- **Session Management**: Persistent sessions to save your work
- **Modern UI**: Responsive, user-friendly interface built with React
- **Database-Driven EPG**: Optimized SQLite database for fast EPG data access
- **Efficient EPG Parser**: Python script to process large XML EPG files into the database

## Installation

### Prerequisites

- Node.js (v14.x or higher)
- npm or yarn
- Python 3.6 or higher (for EPG parsing)

### Backend Setup

```bash
# Navigate to backend directory
cd backend

# Install dependencies
npm install

# Create necessary directories
mkdir -p uploads logs cache data

# Install Python dependencies for EPG parser
pip install -r requirements.txt

# Start the server
npm start
```

### Frontend Setup

```bash
# Navigate to frontend directory
cd frontend

# Install dependencies
npm install

# Start the development server
npm start
```

## Database & EPG Data

The application now uses a SQLite database for efficient EPG data storage and retrieval, which significantly improves performance when handling large EPG datasets.

### EPG Parser

The included Python-based EPG parser (`epg_parser.py`) processes XMLTV files into the SQLite database. It handles both local files and remote URLs, with support for compressed (gzipped) XML data.

#### Running the EPG Parser

```bash
# Basic usage (uses default EPG sources)
python epg_parser.py

# Specify a custom database path
python epg_parser.py --db /path/to/custom/epg.db

# Force refresh all EPG data
python epg_parser.py --force

# Process a specific EPG source only
python epg_parser.py --source https://example.com/epg.xml.gz
```

#### EPG Parser Features

- **Two-Pass Processing**: Ensures all channels are created before programs to avoid foreign key constraint errors
- **Batch Processing**: Efficiently handles large datasets with minimal memory usage
- **Source Management**: Tracks which EPG source each channel and program came from
- **Incremental Updates**: Only processes sources that have changed since the last update
- **Handles Large Files**: Streams XML data rather than loading entire files into memory

## Usage

1. Start both the backend and frontend servers
2. Navigate to http://localhost:3000 in your browser
3. Load your IPTV channels using one of the available methods
4. Browse, search, and match channels with EPG data
5. Play streams directly in the browser

## Troubleshooting

### Large EPG Files

If you encounter the error `Cannot create a string longer than 0x1fffffe8 characters`, it means an EPG file is too large to be processed in memory. The Python EPG parser solves this by streaming the data instead of loading it all at once.

### Database Errors

If you encounter database errors, you may need to rebuild the EPG database:

```bash
# Remove the old database
rm backend/data/epg.db

# Run the parser to rebuild the database
cd backend
python epg_parser.py
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
