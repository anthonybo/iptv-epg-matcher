# PostgreSQL + Redis Migration Plan

## Overview

Migrating IPTV Guru from SQLite + in-memory storage to PostgreSQL + Redis for production-scale deployment supporting 1000+ concurrent users.

## Architecture

### Current State
```
┌─────────────────────────────────┐
│      Node.js Application        │
│  ┌──────────┐   ┌────────────┐  │
│  │ SQLite   │   │ In-Memory  │  │
│  │ iptv.db  │   │ Sessions   │  │
│  └──────────┘   └────────────┘  │
└─────────────────────────────────┘
```

### Target State
```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│ Instance 1  │   │ Instance 2  │   │ Instance 3  │
└──────┬──────┘   └──────┬──────┘   └──────┬──────┘
       │                 │                 │
       └─────────────────┼─────────────────┘
                         │
              ┌──────────┴──────────┐
              │   Load Balancer     │
              └──────────┬──────────┘
                         │
        ┌────────────────┴────────────────┐
        │                                 │
   ┌────▼─────┐                    ┌─────▼─────┐
   │PostgreSQL│                    │   Redis   │
   │  Cluster │                    │  Cluster  │
   └──────────┘                    └───────────┘
   - User data                     - Sessions
   - IPTV sources                  - EPG cache
   - Channels                      - Rate limits
   - Matches                       - Temp data
   - Credentials
```

## PostgreSQL Schema Design

### Tables to Migrate

#### 1. users
```sql
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
```

#### 2. iptv_sources
```sql
CREATE TABLE iptv_sources (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    session_id VARCHAR(255),
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('m3u', 'xtream', 'stalker')),
    url TEXT NOT NULL,
    username VARCHAR(255),
    password VARCHAR(255),
    mac_address VARCHAR(17),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_refreshed TIMESTAMP
);

CREATE INDEX idx_iptv_sources_user_id ON iptv_sources(user_id);
CREATE INDEX idx_iptv_sources_session_id ON iptv_sources(session_id);
CREATE INDEX idx_iptv_sources_type ON iptv_sources(type);
CREATE UNIQUE INDEX idx_iptv_sources_unique ON iptv_sources(user_id, type, url, username)
    WHERE username IS NOT NULL;
```

#### 3. iptv_channels
```sql
CREATE TABLE iptv_channels (
    id SERIAL PRIMARY KEY,
    channel_id VARCHAR(255) UNIQUE NOT NULL,  -- Original: xtream_12345, stalker_67890
    source_id INTEGER REFERENCES iptv_sources(id) ON DELETE CASCADE,
    name VARCHAR(500) NOT NULL,
    stream_url TEXT,
    logo_url TEXT,
    category VARCHAR(255),
    tvg_id VARCHAR(255),
    tvg_name VARCHAR(500),
    group_title VARCHAR(255),
    source_type VARCHAR(50),
    source_username VARCHAR(255),
    source_password VARCHAR(255),
    source_url TEXT,
    source_mac VARCHAR(17),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_iptv_channels_source_id ON iptv_channels(source_id);
CREATE INDEX idx_iptv_channels_channel_id ON iptv_channels(channel_id);
CREATE INDEX idx_iptv_channels_name ON iptv_channels(name);
CREATE INDEX idx_iptv_channels_category ON iptv_channels(category);
CREATE INDEX idx_iptv_channels_tvg_id ON iptv_channels(tvg_id);
```

#### 4. epg_matches
```sql
CREATE TABLE epg_matches (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    iptv_channel_id VARCHAR(255) NOT NULL,
    epg_channel_id VARCHAR(255) NOT NULL,
    use_dummy_epg BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id, iptv_channel_id)
);

CREATE INDEX idx_epg_matches_session_id ON epg_matches(session_id);
CREATE INDEX idx_epg_matches_user_id ON epg_matches(user_id);
CREATE INDEX idx_epg_matches_iptv_channel_id ON epg_matches(iptv_channel_id);
CREATE INDEX idx_epg_matches_epg_channel_id ON epg_matches(epg_channel_id);
```

#### 5. user_epg_sources
```sql
CREATE TABLE user_epg_sources (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    session_id VARCHAR(255),
    name VARCHAR(255) NOT NULL,
    url TEXT NOT NULL,
    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_refreshed TIMESTAMP
);

CREATE INDEX idx_user_epg_sources_user_id ON user_epg_sources(user_id);
CREATE INDEX idx_user_epg_sources_session_id ON user_epg_sources(session_id);
CREATE INDEX idx_user_epg_sources_enabled ON user_epg_sources(enabled);
```

#### 6. credentials
```sql
CREATE TABLE credentials (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    session_id VARCHAR(255),
    username VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    last_used TIMESTAMP
);

CREATE INDEX idx_credentials_user_id ON credentials(user_id);
CREATE INDEX idx_credentials_session_id ON credentials(session_id);
CREATE INDEX idx_credentials_username ON credentials(username);
CREATE INDEX idx_credentials_status ON credentials(status);
```

### Connection Pooling Configuration
```javascript
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: process.env.POSTGRES_PORT || 5432,
    database: process.env.POSTGRES_DB || 'iptvguru',
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    max: 20, // Maximum connections in pool
    min: 5,  // Minimum connections to maintain
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
    ssl: process.env.NODE_ENV === 'production' ? {
        rejectUnauthorized: false
    } : false
});

pool.on('error', (err, client) => {
    console.error('Unexpected error on idle client', err);
});
```

## Redis Architecture

### Redis Data Structures

#### 1. Sessions
```
Key: session:{sessionId}
Type: Hash
TTL: 7 days
Fields:
  - channels: JSON string
  - categories: JSON string
  - epgSources: JSON string
  - createdAt: timestamp
  - lastAccessed: timestamp
  - userId: user ID (if authenticated)
```

#### 2. EPG Cache
```
Key: epg:source:{sourceName}
Type: Hash
TTL: 24 hours
Fields:
  - channels: JSON string (compressed)
  - programs: JSON string (compressed)
  - lastUpdate: timestamp
  - channelCount: number
  - programCount: number
```

#### 3. Rate Limiting
```
Key: ratelimit:{ip}:{endpoint}
Type: String (counter)
TTL: 15 minutes
Value: request count
```

#### 4. SSE Clients (Server-Sent Events)
```
Key: sse:session:{sessionId}
Type: Set
TTL: 1 hour
Members: client IDs
```

### Redis Configuration
```javascript
const Redis = require('ioredis');

// Primary Redis client
const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD,
    db: 0,
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    },
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    enableOfflineQueue: true,
    lazyConnect: false
});

// Redis Cluster configuration (for production)
const cluster = new Redis.Cluster([
    { host: process.env.REDIS_NODE_1, port: 6379 },
    { host: process.env.REDIS_NODE_2, port: 6379 },
    { host: process.env.REDIS_NODE_3, port: 6379 }
], {
    redisOptions: {
        password: process.env.REDIS_PASSWORD
    },
    clusterRetryStrategy: (times) => {
        return Math.min(100 * times, 2000);
    }
});
```

## Migration Steps

### Phase 1: Setup Infrastructure (Week 1, Days 1-2)

#### Step 1: Install Dependencies
```bash
npm install pg ioredis redis connect-redis express-session
npm install --save-dev @types/pg
```

#### Step 2: Setup PostgreSQL
```bash
# Local development with Docker
docker run --name iptvguru-postgres \
    -e POSTGRES_DB=iptvguru \
    -e POSTGRES_USER=iptvguru \
    -e POSTGRES_PASSWORD=changeme \
    -p 5432:5432 \
    -v iptvguru-pgdata:/var/lib/postgresql/data \
    -d postgres:15-alpine

# Create schema
psql -h localhost -U iptvguru -d iptvguru -f backend/migrations/001_initial_schema.sql
```

#### Step 3: Setup Redis
```bash
# Local development with Docker
docker run --name iptvguru-redis \
    -p 6379:6379 \
    -v iptvguru-redisdata:/data \
    -d redis:7-alpine \
    redis-server --appendonly yes
```

### Phase 2: Create Database Service Layer (Week 1, Days 3-4)

#### Step 1: Create PostgreSQL Service
- File: `backend/services/postgresService.js`
- Implement connection pool
- Create query helpers with retry logic
- Add transaction support
- Implement prepared statements

#### Step 2: Create Redis Service
- File: `backend/services/redisService.js`
- Implement session storage
- Implement EPG cache
- Add rate limiting helpers
- Create compression utilities

### Phase 3: Migrate Data Access Layer (Week 1-2)

#### Step 1: Rewrite iptvDatabaseService.js
- Convert all SQLite queries to PostgreSQL
- Use parameterized queries ($1, $2, etc.)
- Implement connection pooling
- Add query performance logging
- Handle concurrent writes properly

#### Step 2: Rewrite sessionStorage.js
- Move to Redis-backed storage
- Implement TTL-based expiration
- Add session refresh on access
- Handle session migration from memory

#### Step 3: Rewrite cacheService.js
- Move EPG cache to Redis
- Implement compression (zlib/gzip)
- Add cache invalidation logic
- Implement lazy loading
- Remove all fs.readFileSync/writeFileSync

### Phase 4: Data Migration Scripts (Week 2)

#### Step 1: Export from SQLite
```javascript
// backend/scripts/export-sqlite-data.js
const sqlite3 = require('sqlite3');
const fs = require('fs').promises;

async function exportData() {
    // Export users
    // Export iptv_sources
    // Export iptv_channels
    // Export epg_matches
    // Export credentials
}
```

#### Step 2: Import to PostgreSQL
```javascript
// backend/scripts/import-postgres-data.js
const { Pool } = require('pg');
const fs = require('fs').promises;

async function importData() {
    // Import users (handle conflicts)
    // Import iptv_sources
    // Import iptv_channels
    // Import epg_matches
    // Import credentials
}
```

### Phase 5: Testing & Validation (Week 2-3)

#### Step 1: Unit Tests
- Test PostgreSQL connection pooling
- Test Redis session storage
- Test concurrent writes
- Test transaction rollbacks

#### Step 2: Integration Tests
- Test multi-instance deployment
- Test session persistence across instances
- Test EPG cache sharing
- Test load balancing

#### Step 3: Load Testing
```bash
# Use Apache Bench or Artillery
artillery quick --count 100 --num 1000 http://localhost:5001/api/channels
```

## Environment Variables

Create `.env` file:
```bash
# PostgreSQL
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=iptvguru
POSTGRES_USER=iptvguru
POSTGRES_PASSWORD=changeme
POSTGRES_MAX_CONNECTIONS=20

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0
REDIS_CLUSTER_ENABLED=false

# Session
SESSION_SECRET=your-secret-key-change-in-production
SESSION_TTL=604800  # 7 days in seconds

# JWT
JWT_SECRET=your-jwt-secret-change-in-production
JWT_EXPIRES_IN=7d

# Application
NODE_ENV=development
PORT=5001
```

## Deployment Configuration

### Docker Compose (Development)
```yaml
version: '3.8'

services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: iptvguru
      POSTGRES_USER: iptvguru
      POSTGRES_PASSWORD: changeme
    ports:
      - "5432:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes

  app:
    build: .
    ports:
      - "5001:5001"
    environment:
      POSTGRES_HOST: postgres
      REDIS_HOST: redis
    depends_on:
      - postgres
      - redis

volumes:
  postgres-data:
  redis-data:
```

### Production Considerations

#### PostgreSQL
- Use managed service (AWS RDS, Google Cloud SQL)
- Enable read replicas for read-heavy operations
- Configure automatic backups (daily + WAL)
- Enable connection pooling via PgBouncer
- Set up monitoring (slow query log, connection count)

#### Redis
- Use managed service (AWS ElastiCache, Redis Cloud)
- Enable Redis Cluster for high availability
- Configure persistence (AOF + RDB)
- Set up monitoring (memory usage, hit rate)
- Enable Redis Sentinel for automatic failover

## Rollback Plan

### If Migration Fails
1. Keep SQLite database as fallback
2. Feature flag to switch between SQLite and PostgreSQL
3. Can run both databases in parallel during transition
4. Gradual migration (migrate tables one at a time)

### Config Flag
```javascript
const USE_POSTGRES = process.env.USE_POSTGRES === 'true';

if (USE_POSTGRES) {
    db = require('./services/postgresService');
} else {
    db = require('./services/iptvDatabaseService');
}
```

## Performance Targets

### Before Migration (SQLite + In-Memory)
- Max concurrent users: ~10
- Max writes/second: ~10
- Session loss on restart: 100%
- Multi-instance support: No

### After Migration (PostgreSQL + Redis)
- Max concurrent users: 1000+
- Max writes/second: 500+
- Session loss on restart: 0%
- Multi-instance support: Yes
- Horizontal scaling: Yes

## Timeline

### Week 1
- Days 1-2: Infrastructure setup (PostgreSQL + Redis)
- Days 3-4: Create new service layers
- Day 5: Begin migration of iptvDatabaseService

### Week 2
- Days 1-3: Complete service migration
- Days 4-5: Data migration scripts + testing

### Week 3
- Days 1-3: Integration testing + bug fixes
- Days 4-5: Load testing + optimization

### Week 4
- Days 1-2: Documentation + deployment guides
- Days 3-5: Production deployment + monitoring

## Success Metrics

- [ ] All 6 tables migrated to PostgreSQL
- [ ] Sessions working in Redis with 7-day TTL
- [ ] EPG cache in Redis with automatic refresh
- [ ] 3+ instances running behind load balancer
- [ ] Zero session loss on instance restart
- [ ] Concurrent write performance >100 writes/second
- [ ] Load test passes: 1000 concurrent users
- [ ] Database migration script tested
- [ ] Rollback plan validated

## Next Steps

After this migration is complete, we'll address:
1. Rate limiting (express-rate-limit)
2. Async file I/O (replace all fs.readFileSync)
3. Circuit breakers for upstream sources
4. Prometheus metrics + monitoring
5. Graceful shutdown handling
