/**
 * Integration tests for postgresService.saveChannels and the related
 * iptv_channels code paths. Uses Node's built-in test runner — no
 * jest/mocha dependency required.
 *
 * Run:
 *   node --test backend/tests/saveChannels.test.js
 *
 * Tests run against the dev postgres database using a sentinel
 * source row reserved for tests (id = TEST_SOURCE_ID) so we don't
 * touch real user data. Each test cleans up after itself.
 */

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const pg = require('../services/postgresService');

// Sentinel source id used by every test. Cleared before/after each
// test so the suite is hermetic. Chosen to be obviously fake.
const TEST_SOURCE_ID = 9990001;

// Ensure the test source row + its iptv_channels partition exist.
// After migration 032 iptv_channels is LIST-partitioned by
// source_id, so every test source needs its partition provisioned
// before any row can land in it.
async function ensureTestSource() {
    await pg.query(
        `INSERT INTO iptv_sources (id, name, type, url, username, password)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [TEST_SOURCE_ID, 'TEST_SAVE_CHANNELS', 'xtream', 'http://test.local', 'test', 'test']
    );
    await pg.ensureChannelsPartition(TEST_SOURCE_ID);
}

async function cleanTestChannels() {
    await pg.query('DELETE FROM iptv_channels WHERE source_id = $1', [TEST_SOURCE_ID]);
}

async function cleanTestSource() {
    await cleanTestChannels();
    await pg.query('DELETE FROM iptv_sources WHERE id = $1', [TEST_SOURCE_ID]);
    // Drop the partition too, so consecutive test runs don't leave
    // orphan iptv_channels_p_9990001 tables around the DB.
    await pg.dropChannelsPartition(TEST_SOURCE_ID);
}

function makeChannel(i, overrides = {}) {
    return {
        id: `test-ch-${i}`,
        name: `Test Channel ${i}`,
        url: `http://test.local/stream/${i}`,
        logo: `http://test.local/logo/${i}.png`,
        category: 'TestCategory',
        tvgId: `tvg-${i}`,
        tvgName: `Test Channel ${i}`,
        groupTitle: 'TestGroup',
        source_type: 'xtream',
        source_username: 'test',
        source_password: 'test',
        source_url: 'http://test.local',
        source_mac: null,
        ...overrides
    };
}

test.before(async () => {
    await ensureTestSource();
    await cleanTestChannels();
});

test.after(async () => {
    await cleanTestSource();
    await pg.close();
});

test('returns {saved: 0} for empty array', async () => {
    const result = await pg.saveChannels([], TEST_SOURCE_ID);
    assert.deepStrictEqual(result, { saved: 0 });
});

test('saves a single channel with all fields preserved', async () => {
    await cleanTestChannels();
    const channel = makeChannel(1);
    const result = await pg.saveChannels([channel], TEST_SOURCE_ID);

    assert.deepStrictEqual(result, { saved: 1 });

    const rows = await pg.query(
        `SELECT channel_id, name, stream_url, logo_url, category,
                tvg_id, tvg_name, group_title, source_id
         FROM iptv_channels WHERE source_id = $1`,
        [TEST_SOURCE_ID]
    );
    assert.strictEqual(rows.rows.length, 1);
    const row = rows.rows[0];
    assert.strictEqual(row.channel_id, channel.id);
    assert.strictEqual(row.name, channel.name);
    assert.strictEqual(row.stream_url, channel.url);
    assert.strictEqual(row.logo_url, channel.logo);
    assert.strictEqual(row.category, channel.category);
    assert.strictEqual(row.tvg_id, channel.tvgId);
    assert.strictEqual(row.tvg_name, channel.tvgName);
    assert.strictEqual(row.group_title, channel.groupTitle);
    assert.strictEqual(row.source_id, TEST_SOURCE_ID);
});

test('saves multiple channels in a single call', async () => {
    await cleanTestChannels();
    const channels = Array.from({ length: 25 }, (_, i) => makeChannel(i));
    const result = await pg.saveChannels(channels, TEST_SOURCE_ID);

    assert.deepStrictEqual(result, { saved: 25 });

    const count = await pg.query(
        'SELECT COUNT(*)::int AS n FROM iptv_channels WHERE source_id = $1',
        [TEST_SOURCE_ID]
    );
    assert.strictEqual(count.rows[0].n, 25);
});

test('deduplicates channels with the same id', async () => {
    await cleanTestChannels();
    const channels = [
        makeChannel(1, { name: 'First wins' }),
        makeChannel(1, { name: 'Second loses' }),
        makeChannel(2),
        makeChannel(1, { name: 'Third also loses' })
    ];
    const result = await pg.saveChannels(channels, TEST_SOURCE_ID);

    assert.deepStrictEqual(result, { saved: 2 });

    const rows = await pg.query(
        'SELECT channel_id, name FROM iptv_channels WHERE source_id = $1 ORDER BY channel_id',
        [TEST_SOURCE_ID]
    );
    assert.strictEqual(rows.rows.length, 2);
    // The "first wins" since we keep the first occurrence in dedup
    assert.strictEqual(rows.rows[0].name, 'First wins');
});

test('replaces existing channels for the source (no leftover rows)', async () => {
    await cleanTestChannels();
    // First save 5 channels
    await pg.saveChannels(
        Array.from({ length: 5 }, (_, i) => makeChannel(i, { name: `old-${i}` })),
        TEST_SOURCE_ID
    );

    // Then save 3 different ones — should fully replace
    await pg.saveChannels(
        [makeChannel(100), makeChannel(101), makeChannel(102)],
        TEST_SOURCE_ID
    );

    const rows = await pg.query(
        'SELECT channel_id FROM iptv_channels WHERE source_id = $1 ORDER BY channel_id',
        [TEST_SOURCE_ID]
    );
    assert.strictEqual(rows.rows.length, 3);
    assert.deepStrictEqual(
        rows.rows.map((r) => r.channel_id),
        ['test-ch-100', 'test-ch-101', 'test-ch-102']
    );
});

test('does not touch channels from other sources', async () => {
    await cleanTestChannels();
    // Get a known existing source that has channels (we don't want
    // to use TEST_SOURCE_ID since we'll be clearing that)
    const otherSource = await pg.query(
        `SELECT source_id, COUNT(*)::int AS n
         FROM iptv_channels
         WHERE source_id <> $1
         GROUP BY source_id
         ORDER BY n DESC
         LIMIT 1`,
        [TEST_SOURCE_ID]
    );
    if (otherSource.rows.length === 0) {
        // No other source has channels — skip rather than fail.
        return;
    }
    const otherSourceId = otherSource.rows[0].source_id;
    const otherCountBefore = otherSource.rows[0].n;

    await pg.saveChannels([makeChannel(1), makeChannel(2)], TEST_SOURCE_ID);

    const otherCountAfter = await pg.query(
        'SELECT COUNT(*)::int AS n FROM iptv_channels WHERE source_id = $1',
        [otherSourceId]
    );
    assert.strictEqual(
        otherCountAfter.rows[0].n,
        otherCountBefore,
        `Saving to source ${TEST_SOURCE_ID} must not touch source ${otherSourceId}`
    );
});

test('honors cancellation between chunks', async () => {
    await cleanTestChannels();
    // Need enough channels to cross at least one chunk boundary
    // (default CHUNK = 10000). We'll cancel on the second call.
    const channels = Array.from({ length: 15000 }, (_, i) => makeChannel(i));
    let chunkCount = 0;
    const isCancelled = () => {
        chunkCount += 1;
        return chunkCount > 1; // cancel after first chunk-boundary check
    };

    const result = await pg.saveChannels(channels, TEST_SOURCE_ID, { isCancelled });
    assert.strictEqual(result.cancelled, true);
    assert.strictEqual(result.saved, 0);

    // Transaction rolled back — no rows committed
    const count = await pg.query(
        'SELECT COUNT(*)::int AS n FROM iptv_channels WHERE source_id = $1',
        [TEST_SOURCE_ID]
    );
    assert.strictEqual(count.rows[0].n, 0, 'cancelled save must roll back');
});

test('handles snake_case props as well as camelCase', async () => {
    await cleanTestChannels();
    const channel = {
        id: 'snake-test',
        name: 'Snake Case Channel',
        url: 'http://test.local/snake',
        logo: 'http://test.local/snake.png',
        category: 'SnakeCat',
        tvg_id: 'snake-tvg',                // snake
        tvg_name: 'Snake Case Channel',     // snake
        group_title: 'SnakeGroup',          // snake
        source_type: 'xtream',
        source_username: 'test',
        source_password: 'test',
        source_url: 'http://test.local',
        source_mac: null
    };
    await pg.saveChannels([channel], TEST_SOURCE_ID);

    const rows = await pg.query(
        'SELECT tvg_id, tvg_name, group_title FROM iptv_channels WHERE source_id = $1',
        [TEST_SOURCE_ID]
    );
    assert.strictEqual(rows.rows.length, 1);
    assert.strictEqual(rows.rows[0].tvg_id, 'snake-tvg');
    assert.strictEqual(rows.rows[0].tvg_name, 'Snake Case Channel');
    assert.strictEqual(rows.rows[0].group_title, 'SnakeGroup');
});

test('updates iptv_sources.channel_count after save', async () => {
    await cleanTestChannels();
    await pg.saveChannels(
        Array.from({ length: 17 }, (_, i) => makeChannel(i)),
        TEST_SOURCE_ID
    );
    const src = await pg.query(
        'SELECT channel_count, last_refresh_status FROM iptv_sources WHERE id = $1',
        [TEST_SOURCE_ID]
    );
    assert.strictEqual(src.rows[0].channel_count, 17);
    assert.strictEqual(src.rows[0].last_refresh_status, 'success');
});

test('getAlternateFeeds returns matching channels across user sources', async () => {
    // Use a real user for this test if available, otherwise skip.
    const users = await pg.query('SELECT id FROM users LIMIT 1');
    if (users.rows.length === 0) return;
    const userId = users.rows[0].id;

    // Ensure the test source is owned by this user and is active in
    // user_iptv_preferences.
    await pg.query('UPDATE iptv_sources SET user_id = $1 WHERE id = $2', [userId, TEST_SOURCE_ID]);
    await pg.query(
        `INSERT INTO user_iptv_preferences (user_id, source_id, priority, is_active)
         VALUES ($1, $2, 1, TRUE)
         ON CONFLICT (user_id, source_id) DO UPDATE SET is_active = TRUE`,
        [userId, TEST_SOURCE_ID]
    );

    await cleanTestChannels();
    await pg.saveChannels([makeChannel(1, { name: 'Alt Feed Test' })], TEST_SOURCE_ID);

    const feeds = await pg.getAlternateFeeds(userId, 'Alt Feed Test');
    assert.ok(Array.isArray(feeds), 'returns an array');
    assert.ok(feeds.length >= 1, `expected at least one feed, got ${feeds.length}`);
    const feed = feeds.find((f) => f.source.id === TEST_SOURCE_ID);
    assert.ok(feed, 'test source feed present');
    assert.strictEqual(feed.name, 'Alt Feed Test');
    assert.strictEqual(feed.source.isActive, true);

    // Cleanup user_iptv_preferences row
    await pg.query(
        'DELETE FROM user_iptv_preferences WHERE source_id = $1',
        [TEST_SOURCE_ID]
    );
});
