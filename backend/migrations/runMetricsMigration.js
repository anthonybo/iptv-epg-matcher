/**
 * Run metrics database migration
 * Creates tables for storing historical metrics data
 */

const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../data/iptv.db');
const MIGRATION_SQL = path.join(__dirname, 'create_metrics_tables.sql');

console.log('Starting metrics database migration...');
console.log('Database:', DB_PATH);
console.log('Migration:', MIGRATION_SQL);

// Read migration SQL
const migrationSQL = fs.readFileSync(MIGRATION_SQL, 'utf8');

// Connect to database
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error connecting to database:', err);
    process.exit(1);
  }
  console.log('Connected to database');
});

// Run migration
db.exec(migrationSQL, (err) => {
  if (err) {
    console.error('Migration failed:', err);
    db.close();
    process.exit(1);
  }

  console.log('✅ Migration completed successfully!');
  console.log('Created tables:');
  console.log('  - metrics_streams');
  console.log('  - metrics_bandwidth');
  console.log('  - metrics_requests');
  console.log('  - metrics_system');
  console.log('  - metrics_sessions');
  console.log('  - metrics_page_views');

  // Verify tables were created
  db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'metrics_%' ORDER BY name`, (err, tables) => {
    if (err) {
      console.error('Error verifying tables:', err);
    } else {
      console.log('\nVerified tables in database:');
      tables.forEach(table => console.log(`  ✓ ${table.name}`));
    }

    db.close((err) => {
      if (err) {
        console.error('Error closing database:', err);
        process.exit(1);
      }
      console.log('\nDatabase connection closed');
      console.log('Migration complete!');
    });
  });
});
