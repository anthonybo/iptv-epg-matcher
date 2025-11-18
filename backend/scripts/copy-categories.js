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

async function copyCategories() {
    console.log('Copying category/group_title data from SQLite to PostgreSQL...');
    
    // Get all channels with group_title from SQLite
    const channels = await new Promise((resolve, reject) => {
        sqliteDb.all(`
            SELECT channel_id, group_title
            FROM iptv_channels
            WHERE group_title IS NOT NULL AND group_title != ''
        `, [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
    
    console.log(`Found ${channels.length} channels with group_title in SQLite`);
    
    // Update PostgreSQL in batches
    let updated = 0;
    for (const channel of channels) {
        try {
            const result = await pgPool.query(`
                UPDATE iptv_channels
                SET category = $1, group_title = $1
                WHERE channel_id = $2
            `, [channel.group_title, channel.channel_id]);
            
            if (result.rowCount > 0) {
                updated++;
                if (updated % 1000 === 0) {
                    console.log(`Updated ${updated} channels...`);
                }
            }
        } catch (err) {
            console.error(`Error updating ${channel.channel_id}:`, err.message);
        }
    }
    
    console.log(`\nTotal updated: ${updated} channels`);
    
    sqliteDb.close();
    await pgPool.end();
}

copyCategories().catch(console.error);
