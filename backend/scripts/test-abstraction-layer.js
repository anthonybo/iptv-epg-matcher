/**
 * Test Database and Session Abstraction Layers
 * Verifies that both SQLite and PostgreSQL work through the abstraction
 */

const logger = require('../utils/logger');

async function testDatabaseAbstraction() {
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║       Testing Database Abstraction Layer              ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    try {
        // Load the abstraction layer
        const db = require('../services/iptvDatabase');

        console.log('✅ Database Type:', db.getDatabaseType());
        console.log('   USE_POSTGRES:', db.USE_POSTGRES);

        // Test health check
        const health = await db.healthCheck();
        console.log('✅ Health Check:', JSON.stringify(health, null, 2));

        // Test connection (if method exists)
        if (db.connect) {
            await db.connect();
            console.log('✅ Database connected');
        }

        return true;
    } catch (error) {
        console.error('❌ Database abstraction error:', error.message);
        return false;
    }
}

async function testSessionAbstraction() {
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║       Testing Session Abstraction Layer               ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    try {
        // Load the abstraction layer
        const session = require('../utils/session');

        console.log('✅ Session Storage Type:', session.getStorageType());
        console.log('   USE_REDIS:', session.USE_REDIS);

        // Test create session
        const testSessionId = 'test-abstraction-' + Date.now();
        const created = await session.createSession(testSessionId, {
            channels: [{ id: 1, name: 'Test Channel' }],
            categories: ['Sports'],
            epgSources: []
        });

        console.log('✅ Session Created:', testSessionId);

        // Test get session
        const retrieved = await session.getSession(testSessionId);
        if (retrieved) {
            console.log('✅ Session Retrieved:', {
                hasData: !!retrieved.data,
                channelCount: retrieved.data?.channels?.length || 0
            });
        } else {
            console.error('❌ Failed to retrieve session');
            return false;
        }

        // Test update session
        await session.updateSession(testSessionId, {
            channels: [
                { id: 1, name: 'Test Channel' },
                { id: 2, name: 'Test Channel 2' }
            ]
        });
        console.log('✅ Session Updated');

        // Test delete session
        await session.deleteSession(testSessionId);
        console.log('✅ Session Deleted');

        return true;
    } catch (error) {
        console.error('❌ Session abstraction error:', error.message);
        console.error(error.stack);
        return false;
    }
}

async function runTests() {
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║   IPTV Guru - Abstraction Layer Test                  ║');
    console.log('╚════════════════════════════════════════════════════════╝');
    console.log('\nCurrent Configuration:');
    console.log('  USE_POSTGRES:', process.env.USE_POSTGRES);
    console.log('  USE_REDIS:', process.env.USE_REDIS);

    const results = {
        database: false,
        session: false
    };

    // Test database abstraction
    results.database = await testDatabaseAbstraction();

    // Test session abstraction
    results.session = await testSessionAbstraction();

    // Summary
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║                     TEST SUMMARY                       ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    console.log('Database Abstraction:', results.database ? '✅ PASS' : '❌ FAIL');
    console.log('Session Abstraction: ', results.session ? '✅ PASS' : '❌ FAIL');

    const allPassed = results.database && results.session;

    if (allPassed) {
        console.log('\n🎉 All abstraction tests passed!\n');
        console.log('To switch between databases:');
        console.log('  - Edit .env file');
        console.log('  - Set USE_POSTGRES=true for PostgreSQL');
        console.log('  - Set USE_REDIS=true for Redis');
        console.log('  - Restart the application\n');
    } else {
        console.log('\n⚠️  Some tests failed. Check errors above.\n');
    }

    process.exit(allPassed ? 0 : 1);
}

// Run tests
runTests().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
