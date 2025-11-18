const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');

const sqliteDb = new sqlite3.Database('/Users/anthonybo/projects/iptv-epg-matcher/backend/data/iptv.db');
const pgPool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'iptvguru',
    user: 'iptvguru',
    password: process.env.POSTGRES_PASSWORD
});

async function migrateMissingChannels() {
    const missingSources = [8, 10, 13, 18, 20];

    for (const sourceId of missingSources) {
        console.log(`\nMigrating channels for source ${sourceId}...`);

        // Get channels from SQLite
        const channels = await new Promise((resolve, reject) => {
            sqliteDb.all(`
                SELECT * FROM iptv_channels WHERE source_id = ?
            `, [sourceId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        console.log(`Found ${channels.length} channels in SQLite for source ${sourceId}`);

        if (channels.length === 0) continue;

        // Insert in batches of 500
        const batchSize = 500;
        let inserted = 0;

        for (let i = 0; i < channels.length; i += batchSize) {
            const batch = channels.slice(i, i + batchSize);

            const values = [];
            const params = [];

            batch.forEach((ch, idx) => {
                const offset = idx * 14;
                values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14})`);

                params.push(
                    ch.channel_id,
                    sourceId,
                    ch.name,
                    ch.url,
                    ch.logo,
                    ch.group_title,
                    ch.epg_channel_id,
                    ch.name, // tvg_name
                    ch.group_title, // group_title
                    null, // source_type
                    null, // source_username
                    null, // source_password
                    null, // source_url
                    null  // source_mac
                );
            });

            const query = `
                INSERT INTO iptv_channels (
                    channel_id, source_id, name, stream_url, logo_url, category,
                    tvg_id, tvg_name, group_title, source_type, source_username,
                    source_password, source_url, source_mac
                )
                VALUES ${values.join(', ')}
                ON CONFLICT (channel_id) DO UPDATE SET
                    source_id = EXCLUDED.source_id,
                    name = EXCLUDED.name,
                    stream_url = EXCLUDED.stream_url,
                    logo_url = EXCLUDED.logo_url,
                    category = EXCLUDED.category,
                    group_title = EXCLUDED.group_title,
                    updated_at = CURRENT_TIMESTAMP
            `;

            await pgPool.query(query, params);
            inserted += batch.length;
        }

        console.log(`Migrated ${inserted} channels for source ${sourceId}`);
    }

    sqliteDb.close();
    await pgPool.end();
    console.log('\nMigration complete!');
}

migrateMissingChannels().catch(console.error);
