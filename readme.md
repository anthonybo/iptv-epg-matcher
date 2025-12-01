# IPTV Guru

A powerful web application for managing IPTV channels, matching EPG (Electronic Program Guide) data, and watching live streams with multi-view support.

## Overview

IPTV Guru allows you to:
- Manage multiple IPTV sources (M3U, Xtream API, Stalker portals)
- Auto-match or manually match channels with EPG data from multiple sources
- Watch live TV streams directly in your browser with adaptive playback
- View multiple streams simultaneously with Multi-View mode
- Discover live sports events and auto-fill streams
- Generate Xtream credentials with properly matched EPG data
- Browse channels with a TV Guide interface

## Features

### Source Management
- **M3U Support**: Load channels from M3U files or URLs
- **Xtream API**: Connect to Xtream-compatible IPTV providers
- **Stalker Portals**: Full support for Stalker/MAC-based portals with token refresh
- **Multiple Sources**: Manage multiple IPTV sources simultaneously

### EPG Management
- **Multiple EPG Sources**: Aggregate EPG data from multiple XMLTV sources
- **Automatic Matching**: Smart algorithms suggest matching EPG IDs
- **Manual Matching**: Search and match channels manually when needed
- **Dummy EPG**: Generate placeholder EPG for channels without guide data
- **Custom EPG Sources**: Add your own EPG URLs

### Streaming & Playback
- **MPEG-TS Player**: Native browser playback using mpegts.js
- **HLS Support**: Fallback to HLS for compatible streams
- **Stream Proxy**: Backend proxy for CORS-restricted streams
- **Auto-Recovery**: Automatic reconnection on stream failures
- **Quality Detection**: Real-time video quality display

### Multi-View
- **Grid Layout**: Watch up to 9 streams simultaneously
- **Drag & Drop**: Reorder streams by dragging
- **Auto-Fill**: Automatically populate streams by sport/category
- **Theatre Mode**: Fullscreen multi-view experience
- **Per-Stream Controls**: Mute, refresh, or remove individual streams

### Live Sports
- **Event Discovery**: Browse live and upcoming sports events
- **Auto-Test**: Automatically find working streams for events
- **Smart Search**: Search channels by event name
- **Blacklist**: Exclude problematic channels from searches

### TV Guide
- **Grid View**: Traditional EPG grid layout
- **Current Time Indicator**: Visual timeline with current position
- **Program Details**: View program descriptions and timing
- **Quick Play**: Start watching directly from the guide

## Tech Stack

- **Frontend**: React, Tailwind CSS
- **Backend**: Node.js, Express
- **Database**: PostgreSQL (primary), SQLite (EPG cache)
- **Cache**: Redis (sessions, rate limiting)
- **Streaming**: mpegts.js, Clappr player

## Installation

### Prerequisites

- Node.js (v16.x or higher)
- PostgreSQL 15+
- Redis (optional, for sessions/caching)
- Docker & Docker Compose (recommended)

### Quick Start with Docker

```bash
# Clone the repository
git clone https://github.com/yourusername/iptv-epg-matcher.git
cd iptv-epg-matcher

# Copy environment file
cp .env.example .env

# Start PostgreSQL and Redis
docker-compose up -d

# Install dependencies
npm install
cd backend && npm install && cd ..
cd frontend && npm install && cd ..

# Start the application
npm start
```

### Manual Setup

#### Database Setup

```bash
# Start PostgreSQL and Redis with Docker
docker-compose up -d postgres redis

# Or connect to existing PostgreSQL instance
# Update .env with your database credentials
```

#### Backend Setup

```bash
cd backend

# Install dependencies
npm install

# Create necessary directories
mkdir -p uploads logs cache data

# Start the server
npm start
```

#### Frontend Setup

```bash
cd frontend

# Install dependencies
npm install

# Start the development server
npm start
```

### Running Both Services

From the project root:

```bash
npm start
```

This runs both backend (port 5001) and frontend (port 3000) concurrently.

## Configuration

Copy `.env.example` to `.env` and configure:

### Required Settings

```env
# PostgreSQL
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=iptvguru
POSTGRES_USER=iptvguru
POSTGRES_PASSWORD=changeme

# Security
JWT_SECRET=your-jwt-secret-change-in-production
SESSION_SECRET=your-session-secret-change-in-production
```

### Optional Settings

```env
# Redis (for sessions/caching)
REDIS_HOST=localhost
REDIS_PORT=6379

# EPG Settings
EPG_CACHE_TTL=86400
EPG_REFRESH_INTERVAL=43200

# Streaming
STREAM_TIMEOUT=30000
MAX_STREAM_CONNECTIONS=100
```

## Usage

1. Navigate to http://localhost:3000
2. Register an account or log in
3. Add your IPTV sources (M3U URL, Xtream credentials, or Stalker portal)
4. Browse channels and match them with EPG data
5. Watch streams directly or use Multi-View for multiple streams

### Adding IPTV Sources

**M3U URL:**
- Enter the M3U playlist URL
- Channels will be automatically imported

**Xtream API:**
- Enter server URL, username, and password
- Both live channels and VOD are supported

**Stalker Portal:**
- Enter portal URL and MAC address
- Token refresh is handled automatically

### Multi-View

1. Navigate to Multi-View from the sidebar
2. Click "Add Stream" or use sport auto-fill
3. Drag streams to reorder
4. Use individual controls to mute/refresh/remove streams

### Live Sports

1. Go to Live Events from the sidebar
2. Browse by sport category
3. Click "Auto-Test" to find working streams
4. Add working streams to Multi-View

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login and get JWT token
- `GET /api/auth/profile` - Get user profile

### IPTV Sources
- `GET /api/iptv-sources` - List all sources
- `POST /api/iptv-sources` - Add new source
- `DELETE /api/iptv-sources/:id` - Remove source

### Channels
- `GET /api/channels` - List channels (with pagination)
- `GET /api/channels/:id` - Get channel details

### Streaming
- `GET /api/stream/:sessionId/:channelId` - Stream a channel
- `GET /api/xtream/*` - Xtream API proxy

### EPG
- `GET /api/epg/channels` - List EPG channels
- `POST /api/epg/match` - Match IPTV channel to EPG
- `GET /api/epg/programs/:channelId` - Get programs for channel

### Live Events
- `GET /api/live-events/sports` - List available sports
- `POST /api/live-events/random-working-stream` - Find working stream for event
- `POST /api/live-events/auto-fill-streams` - Auto-fill multi-view by sport

## Architecture

```
├── backend/
│   ├── routes/          # API endpoints
│   ├── services/        # Business logic
│   ├── middleware/      # Auth, rate limiting
│   ├── config/          # Configuration
│   └── migrations/      # Database migrations
├── frontend/
│   ├── src/
│   │   ├── components/  # React components
│   │   ├── contexts/    # React contexts
│   │   ├── hooks/       # Custom hooks
│   │   ├── pages/       # Page components
│   │   ├── services/    # API services
│   │   └── utils/       # Utility functions
└── docker-compose.yml   # Docker services
```

## Performance

- **Connection Pooling**: HTTP agents with keep-alive for upstream requests
- **Parallel Testing**: Concurrent stream validation (3 at a time)
- **Bandwidth Batching**: Metrics updates batched to reduce overhead
- **React.memo**: Component memoization to prevent unnecessary re-renders
- **Debouncing**: Channel changes debounced to handle React StrictMode

## Troubleshooting

### Streams not playing
- Check browser console for errors
- Verify the IPTV source is online
- Try a different playback method (HLS vs MPEG-TS)
- Check backend logs at `backend/logs/combined-*.log`

### EPG not showing
- Ensure EPG sources are configured and refreshed
- Match channels to EPG using the EPG Matcher
- Check if EPG data exists for the time range

### Database errors
- Ensure PostgreSQL is running: `docker-compose ps`
- Check connection settings in `.env`
- Run migrations if needed

### High memory usage
- Reduce MAX_STREAM_CONNECTIONS
- Enable Redis for session storage
- Increase Node.js memory: `NODE_MAX_OLD_SPACE_SIZE=4096`

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
