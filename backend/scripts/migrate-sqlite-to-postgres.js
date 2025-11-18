/**
 * SQLite to PostgreSQL Data Migration Script
 * Migrates all IPTV data from SQLite to PostgreSQL
 */

const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const path = require('path');

// PostgreSQL connection
const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT) || 5432,
    database: process.env.POSTGRES_DB || 'iptvguru',
    user: process.env.POSTGRES_USER || 'iptvguru',
    password: process.env.POSTGRES_PASSWORD,
    max: 20
});

// SQLite connection
const dbPath = path.join(__dirname, '../data/iptv.db');
const sqliteDb = new sqlite3.Database(dbPath);

// Promisify SQLite operations
function sqliteAll(query, params = []) {
    return new Promise((resolve, reject) => {
        sqliteDb.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

/**
 * Migrate users table
 */
async function migrateUsers() {
    console.log('\n📊 Migrating users...');

    const users = await sqliteAll('SELECT * FROM users ORDER BY id');
    console.log(`Found ${users.length} users in SQLite`);

    for (const user of users) {
        try {
            await pool.query(`
                INSERT INTO users (id, username, email, password_hash, created_at, last_login)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (id) DO UPDATE SET
                    username = EXCLUDED.username,
                    email = EXCLUDED.email,
                    last_login = EXCLUDED.last_login
            `, [
                user.id,
                user.username,
                user.email,
                user.password_hash,
                user.created_at || new Date().toISOString(),
                user.last_login
            ]);
            console.log(`  ✓ Migrated user: ${user.username}`);
        } catch (error) {
            console.error(`  ✗ Error migrating user ${user.username}:`, error.message);
        }
    }
}

/**
 * Migrate IPTV sources
 */
async function migrateIPTVSources() {
    console.log('\n📡 Migrating IPTV sources...');

    const sources = await sqliteAll('SELECT * FROM iptv_sources ORDER BY id');
    console.log(`Found ${sources.length} IPTV sources in SQLite`);

    const sourceIdMap = new Map(); // Map old IDs to new IDs

    for (const source of sources) {
        try {
            const result = await pool.query(`
                INSERT INTO iptv_sources (
                    id, user_id, session_id, name, type, url, username, password,
                    mac_address, created_at, updated_at, last_refreshed,
                    is_active, priority, nickname, auto_detect_live
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                ON CONFLICT (id) DO UPDATE SET
                    mac_address = EXCLUDED.mac_address,
                    updated_at = EXCLUDED.updated_at
                RETURNING id
            `, [
                source.id,  // Preserve original SQLite ID
                source.user_id,
                source.session_id,
                source.name,
                source.type,
                source.url,
                source.username,
                source.password,
                source.mac_address,  // SQLite uses mac_address, not mac
                source.created_at || new Date().toISOString(),
                source.updated_at || new Date().toISOString(),
                source.last_refreshed,
                source.is_active !== 0,  // Convert SQLite integer to PostgreSQL boolean
                source.priority || 0,
                source.nickname,
                source.auto_detect_live !== 0  // Convert SQLite integer to PostgreSQL boolean
            ]);

            const newId = result.rows[0].id;
            sourceIdMap.set(source.id, newId);
            console.log(`  ✓ Migrated source: ${source.name} (old ID: ${source.id}, new ID: ${newId})`);
        } catch (error) {
            console.error(`  ✗ Error migrating source ${source.name}:`, error.message);
        }
    }

    return sourceIdMap;
}

/**
 * Migrate IPTV channels
 */
async function migrateIPTVChannels(sourceIdMap) {
    console.log('\n📺 Migrating IPTV channels...');

    const channels = await sqliteAll('SELECT * FROM iptv_channels ORDER BY id');
    console.log(`Found ${channels.length} channels in SQLite`);

    let migrated = 0;
    let failed = 0;

    // Batch insert for better performance
    const batchSize = 1000;
    for (let i = 0; i < channels.length; i += batchSize) {
        const batch = channels.slice(i, i + batchSize);

        try {
            const client = await pool.connect();

            try {
                await client.query('BEGIN');

                for (const channel of batch) {
                    const newSourceId = sourceIdMap.get(channel.source_id);
                    if (!newSourceId) {
                        console.warn(`  ⚠ Skipping channel ${channel.channel_id}: source ${channel.source_id} not found`);
                        failed++;
                        continue;
                    }

                    try {
                        await client.query(`
                            INSERT INTO iptv_channels (
                                channel_id, name, group_title, logo_url, stream_url, source_id,
                                category, tvg_id, created_at, updated_at
                            )
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                            ON CONFLICT (channel_id) DO UPDATE SET
                                name = EXCLUDED.name,
                                group_title = EXCLUDED.group_title,
                                logo_url = EXCLUDED.logo_url,
                                stream_url = EXCLUDED.stream_url,
                                source_id = EXCLUDED.source_id,
                                category = EXCLUDED.category,
                                updated_at = EXCLUDED.updated_at
                        `, [
                            channel.channel_id,
                            channel.name,
                            channel.group_title,
                            channel.logo,  // SQLite 'logo' → PostgreSQL 'logo_url'
                            channel.url,   // SQLite 'url' → PostgreSQL 'stream_url'
                            newSourceId,
                            channel.group_title,  // Use group_title as category too
                            channel.epg_channel_id,  // SQLite 'epg_channel_id' → PostgreSQL 'tvg_id'
                            channel.created_at || new Date().toISOString(),
                            channel.updated_at || new Date().toISOString()
                        ]);
                        migrated++;
                    } catch (error) {
                        console.error(`  ✗ Error migrating channel ${channel.channel_id}:`, error.message);
                        failed++;
                    }
                }

                await client.query('COMMIT');
                console.log(`  ✓ Migrated batch ${i + 1}-${Math.min(i + batchSize, channels.length)} of ${channels.length} channels`);
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            console.error(`  ✗ Error in batch ${i}:`, error.message);
            failed += batch.length;
        }
    }

    console.log(`  Summary: ${migrated} migrated, ${failed} failed`);
}

/**
 * Migrate EPG matches
 */
async function migrateEPGMatches() {
    console.log('\n🔗 Migrating EPG matches...');

    const matches = await sqliteAll('SELECT * FROM epg_matches ORDER BY id');
    console.log(`Found ${matches.length} EPG matches in SQLite`);

    for (const match of matches) {
        try {
            await pool.query(`
                INSERT INTO epg_matches (
                    session_id, user_id, iptv_channel_id, epg_channel_id,
                    use_dummy_epg, created_at
                )
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (session_id, iptv_channel_id) DO UPDATE SET
                    epg_channel_id = EXCLUDED.epg_channel_id,
                    use_dummy_epg = EXCLUDED.use_dummy_epg
            `, [
                match.session_id,
                match.user_id,
                match.iptv_channel_id,
                match.epg_channel_id,
                match.use_dummy_epg !== 0,  // Convert SQLite integer to PostgreSQL boolean
                match.created_at || new Date().toISOString()
            ]);
            console.log(`  ✓ Migrated match: ${match.iptv_channel_id} → ${match.epg_channel_id}`);
        } catch (error) {
            console.error(`  ✗ Error migrating match ${match.id}:`, error.message);
        }
    }
}

/**
 * Migrate user EPG sources
 */
async function migrateUserEPGSources() {
    console.log('\n🌐 Migrating user EPG sources...');

    const sources = await sqliteAll('SELECT * FROM user_epg_sources ORDER BY id');
    console.log(`Found ${sources.length} user EPG sources in SQLite`);

    for (const source of sources) {
        try {
            await pool.query(`
                INSERT INTO user_epg_sources (
                    user_id, session_id, name, url, enabled,
                    created_at, updated_at, last_refreshed
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT DO NOTHING
            `, [
                source.user_id,
                source.session_id,
                source.name,
                source.url,
                source.enabled !== 0,  // Convert SQLite integer to PostgreSQL boolean
                source.created_at || new Date().toISOString(),
                source.updated_at || new Date().toISOString(),
                source.last_refreshed
            ]);
            console.log(`  ✓ Migrated user EPG source: ${source.name}`);
        } catch (error) {
            console.error(`  ✗ Error migrating user EPG source ${source.name}:`, error.message);
        }
    }
}

/**
 * Main migration function
 */
async function migrate() {
    console.log('🚀 Starting SQLite → PostgreSQL migration...');
    console.log('='.repeat(50));

    try {
        // Test connections
        console.log('\n🔌 Testing connections...');
        await pool.query('SELECT NOW()');
        console.log('  ✓ PostgreSQL connection OK');
        await sqliteAll('SELECT 1');
        console.log('  ✓ SQLite connection OK');

        // Perform migrations in order (respecting foreign keys)
        await migrateUsers();
        const sourceIdMap = await migrateIPTVSources();
        await migrateIPTVChannels(sourceIdMap);
        await migrateEPGMatches();
        await migrateUserEPGSources();

        console.log('\n' + '='.repeat(50));
        console.log('✅ Migration completed successfully!');
        console.log('\nNext steps:');
        console.log('  1. Restart your backend server');
        console.log('  2. Test the application with PostgreSQL');
        console.log('  3. If everything works, you can keep SQLite as backup');
    } catch (error) {
        console.error('\n❌ Migration failed:', error);
        throw error;
    } finally {
        // Close connections
        sqliteDb.close();
        await pool.end();
    }
}

// Run migration
if (require.main === module) {
    migrate()
        .then(() => process.exit(0))
        .catch(err => {
            console.error('Fatal error:', err);
            process.exit(1);
        });
}

module.exports = { migrate };
