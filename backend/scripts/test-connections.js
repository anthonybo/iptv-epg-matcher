/**
 * Test PostgreSQL and Redis Connections
 * Run this to verify your database setup
 */

const postgresService = require('../services/postgresService');
const redisService = require('../services/redisService');
const logger = require('../utils/logger');

async function testPostgreSQL() {
    console.log('\n=== Testing PostgreSQL Connection ===\n');

    try {
        const health = await postgresService.healthCheck();
        console.log('✅ PostgreSQL Health Check:', JSON.stringify(health, null, 2));

        // Test query
        const result = await postgresService.query('SELECT NOW() as current_time, version() as version');
        console.log('✅ PostgreSQL Query Test:');
        console.log('   Current Time:', result.rows[0].current_time);
        console.log('   Version:', result.rows[0].version.split('\n')[0]);

        // Check tables
        const tables = await postgresService.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
            ORDER BY table_name
        `);
        console.log('\n✅ Database Tables:', tables.rows.map(r => r.table_name).join(', '));

        // Check connection pool stats
        console.log('\n✅ Connection Pool Stats:');
        console.log('   Total connections:', postgresService.pool.totalCount);
        console.log('   Idle connections:', postgresService.pool.idleCount);
        console.log('   Waiting clients:', postgresService.pool.waitingCount);

        return true;
    } catch (error) {
        console.error('❌ PostgreSQL Error:', error.message);
        console.error('\nTroubleshooting:');
        console.error('1. Make sure PostgreSQL is running (port 5432)');
        console.error('2. Check your .env file has correct POSTGRES_* variables');
        console.error('3. Verify database "iptvguru" exists');
        console.error('4. Run the migration: psql -U iptvguru -d iptvguru < backend/migrations/001_initial_schema.sql');
        return false;
    }
}

async function testRedis() {
    console.log('\n=== Testing Redis Connection ===\n');

    try {
        const health = await redisService.healthCheck();
        console.log('✅ Redis Health Check:', JSON.stringify(health, null, 2));

        // Test basic operations
        await redisService.set('test:key', { message: 'Hello from IPTV Guru!' }, 60);
        const value = await redisService.get('test:key');
        console.log('✅ Redis Set/Get Test:', value);

        // Test session
        const testSessionId = 'test-session-' + Date.now();
        await redisService.saveSession(testSessionId, {
            channels: [{ id: 1, name: 'Test Channel' }],
            categories: ['Sports', 'News'],
            epgSources: [],
            userId: null
        });
        console.log('✅ Redis Session Save: Success');

        const session = await redisService.getSession(testSessionId);
        console.log('✅ Redis Session Get:', JSON.stringify(session, null, 2));

        // Cleanup
        await redisService.deleteSession(testSessionId);
        await redisService.del('test:key');
        console.log('✅ Redis Cleanup: Success');

        return true;
    } catch (error) {
        console.error('❌ Redis Error:', error.message);
        console.error('\nTroubleshooting:');
        console.error('1. Make sure Redis is running (port 6379)');
        console.error('2. Check your .env file has correct REDIS_* variables');
        console.error('3. Try: redis-cli ping (should return PONG)');
        return false;
    }
}

async function testRateLimit() {
    console.log('\n=== Testing Rate Limiting ===\n');

    try {
        const testKey = 'test-user-' + Date.now();

        // Make 5 requests
        for (let i = 1; i <= 5; i++) {
            const result = await redisService.checkRateLimit(testKey, 3, 60);
            console.log(`Request ${i}:`, {
                allowed: result.allowed,
                current: result.current,
                remaining: result.remaining
            });
        }

        // Reset
        await redisService.resetRateLimit(testKey);
        console.log('✅ Rate Limit Reset: Success');

        return true;
    } catch (error) {
        console.error('❌ Rate Limit Error:', error.message);
        return false;
    }
}

async function runTests() {
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║   IPTV Guru - PostgreSQL & Redis Connection Test      ║');
    console.log('╚════════════════════════════════════════════════════════╝');

    const results = {
        postgres: false,
        redis: false,
        rateLimit: false
    };

    // Test PostgreSQL
    results.postgres = await testPostgreSQL();

    // Test Redis
    results.redis = await testRedis();

    // Test Rate Limiting
    if (results.redis) {
        results.rateLimit = await testRateLimit();
    }

    // Summary
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║                     TEST SUMMARY                       ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    console.log('PostgreSQL Connection:', results.postgres ? '✅ PASS' : '❌ FAIL');
    console.log('Redis Connection:     ', results.redis ? '✅ PASS' : '❌ FAIL');
    console.log('Rate Limiting:        ', results.rateLimit ? '✅ PASS' : '❌ FAIL');

    const allPassed = results.postgres && results.redis && results.rateLimit;

    if (allPassed) {
        console.log('\n🎉 All tests passed! Your infrastructure is ready.\n');
        console.log('Next steps:');
        console.log('1. Update server.js to use PostgreSQL and Redis');
        console.log('2. Migrate existing SQLite data (if any)');
        console.log('3. Test the application end-to-end');
    } else {
        console.log('\n⚠️  Some tests failed. Please fix the issues above.\n');
    }

    // Cleanup
    await postgresService.close();
    await redisService.close();

    process.exit(allPassed ? 0 : 1);
}

// Run tests
runTests().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
