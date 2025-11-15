# Quick Start: PostgreSQL + Redis Setup

## Prerequisites

- Docker and Docker Compose installed
- Node.js 14+ installed
- Git

## 1. Setup Environment

```bash
# Copy environment template
cp .env.example .env

# Edit .env if needed (defaults work for local development)
# The defaults point to localhost:5432 (PostgreSQL) and localhost:6379 (Redis)
```

## 2. Start PostgreSQL and Redis

```bash
# Start databases with Docker Compose
docker-compose up -d postgres redis

# Check if services are running
docker-compose ps

# You should see:
# - iptvguru-postgres (healthy)
# - iptvguru-redis (healthy)
```

## 3. Initialize Database

```bash
# Run the database migration to create schema
docker exec -i iptvguru-postgres psql -U iptvguru -d iptvguru < backend/migrations/001_initial_schema.sql

# Verify tables were created
docker exec -it iptvguru-postgres psql -U iptvguru -d iptvguru -c "\dt"

# You should see:
# - users
# - iptv_sources
# - iptv_channels
# - epg_matches
# - user_epg_sources
# - credentials
# - schema_migrations
```

## 4. Install Dependencies

```bash
# Install backend dependencies
cd backend
npm install

# Install frontend dependencies (if not already done)
cd ../frontend
npm install
```

## 5. Run the Application

```bash
# From project root, start both backend and frontend
npm start

# OR run them separately:

# Terminal 1 - Backend
cd backend
npm start

# Terminal 2 - Frontend
cd frontend
npm start
```

## 6. Verify Setup

### Check PostgreSQL Connection

```bash
# Check database health
docker exec -it iptvguru-postgres psql -U iptvguru -d iptvguru -c "SELECT NOW();"

# Check connection pool
curl http://localhost:5001/api/health/postgres
```

### Check Redis Connection

```bash
# Check Redis
docker exec -it iptvguru-redis redis-cli ping
# Should return: PONG

# Check Redis via API
curl http://localhost:5001/api/health/redis
```

## 7. Optional: Migrate Existing SQLite Data

If you have existing data in SQLite that you want to migrate:

```bash
# Run migration script (to be created)
cd backend
node scripts/migrate-sqlite-to-postgres.js
```

## Troubleshooting

### PostgreSQL not starting

```bash
# Check logs
docker-compose logs postgres

# Common issue: Port 5432 already in use
# Solution: Stop existing PostgreSQL or change POSTGRES_PORT in .env
```

### Redis not starting

```bash
# Check logs
docker-compose logs redis

# Common issue: Port 6379 already in use
# Solution: Stop existing Redis or change REDIS_PORT in .env
```

### Connection refused errors

```bash
# Make sure services are healthy
docker-compose ps

# Restart services
docker-compose restart postgres redis

# Check backend logs
cd backend
npm start
# Look for "PostgreSQL client connected" and "Redis client ready"
```

### Reset Everything

```bash
# Stop all services
docker-compose down

# Remove volumes (WARNING: This deletes all data!)
docker-compose down -v

# Start fresh
docker-compose up -d postgres redis
docker exec -i iptvguru-postgres psql -U iptvguru -d iptvguru < backend/migrations/001_initial_schema.sql
```

## Database Management

### Connect to PostgreSQL

```bash
# Using psql
docker exec -it iptvguru-postgres psql -U iptvguru -d iptvguru

# Common commands:
# \dt           - List tables
# \d users      - Describe users table
# \q            - Quit
```

### Connect to Redis

```bash
# Using redis-cli
docker exec -it iptvguru-redis redis-cli

# Common commands:
# KEYS *              - List all keys
# GET session:xyz     - Get session data
# FLUSHDB             - Clear current database
# QUIT                - Exit
```

### Backup Database

```bash
# Backup PostgreSQL
docker exec iptvguru-postgres pg_dump -U iptvguru iptvguru > backup_$(date +%Y%m%d).sql

# Backup Redis
docker exec iptvguru-redis redis-cli SAVE
docker cp iptvguru-redis:/data/dump.rdb ./redis_backup_$(date +%Y%m%d).rdb
```

### Restore Database

```bash
# Restore PostgreSQL
docker exec -i iptvguru-postgres psql -U iptvguru -d iptvguru < backup_20250115.sql

# Restore Redis
docker cp redis_backup_20250115.rdb iptvguru-redis:/data/dump.rdb
docker-compose restart redis
```

## Production Deployment

For production deployment, see `docs/POSTGRESQL_REDIS_MIGRATION.md` for:
- Managed database services (AWS RDS, ElastiCache)
- Connection pooling with PgBouncer
- Redis Cluster setup
- High availability configuration
- Monitoring and alerting
- Backup strategies

## Next Steps

1. Test the application with PostgreSQL and Redis
2. Monitor performance and connection pool usage
3. Set up monitoring (Prometheus/Grafana)
4. Configure production environment
5. Plan horizontal scaling (multiple instances)
