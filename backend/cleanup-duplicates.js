const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'iptv.db');
const db = new sqlite3.Database(dbPath);

console.log('🧹 Starting duplicate cleanup...');

db.serialize(() => {
    // Count duplicates before
    db.get(`SELECT COUNT(*) as total FROM iptv_channels`, (err, before) => {
        if (err) {
            console.error('Error counting channels:', err);
            return;
        }

        console.log(`📊 Total channels before cleanup: ${before.total}`);

        // Delete duplicates, keeping only the latest entry (max id) for each channel_id
        db.run(`
            DELETE FROM iptv_channels
            WHERE id NOT IN (
                SELECT MAX(id)
                FROM iptv_channels
                GROUP BY channel_id
            )
        `, function(deleteErr) {
            if (deleteErr) {
                console.error('❌ Error deleting duplicates:', deleteErr);
                db.close();
                return;
            }

            console.log(`✅ Deleted ${this.changes} duplicate channel entries`);

            // Count after cleanup
            db.get(`SELECT COUNT(*) as total FROM iptv_channels`, (countErr, after) => {
                if (countErr) {
                    console.error('Error counting after cleanup:', countErr);
                    db.close();
                    return;
                }

                console.log(`📊 Total channels after cleanup: ${after.total}`);
                console.log(`🎉 Cleanup complete! Removed ${before.total - after.total} duplicates`);

                // Vacuum to reclaim space
                db.run('VACUUM', (vacErr) => {
                    if (vacErr) {
                        console.error('Error vacuuming database:', vacErr);
                    } else {
                        console.log('💾 Database optimized');
                    }
                    db.close();
                });
            });
        });
    });
});
