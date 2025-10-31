/**
 * Database Migration: Add User Authentication
 * This migration adds user authentication tables and updates existing tables
 * to support user-specific data.
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const logger = require('../config/logger');

const DB_PATH = path.join(__dirname, '../data/iptv.db');

/**
 * Run the migration
 * @returns {Promise<void>}
 */
async function up() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        logger.error(`Error connecting to database: ${err.message}`);
        return reject(err);
      }

      logger.info('Running migration: Add User Authentication');

      // Run all migration steps in a transaction
      db.serialize(() => {
        db.run('BEGIN TRANSACTION', (err) => {
          if (err) {
            logger.error(`Error starting transaction: ${err.message}`);
            return reject(err);
          }

          // Create users table
          db.run(`
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              username TEXT UNIQUE NOT NULL,
              email TEXT UNIQUE NOT NULL,
              password_hash TEXT NOT NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              last_login TIMESTAMP
            )
          `, (err) => {
            if (err) {
              logger.error(`Error creating users table: ${err.message}`);
              db.run('ROLLBACK');
              return reject(err);
            }
            logger.info('Created users table');

            // Create indexes for users table
            db.run(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`, (err) => {
              if (err) {
                logger.error(`Error creating username index: ${err.message}`);
                db.run('ROLLBACK');
                return reject(err);
              }

              db.run(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`, (err) => {
                if (err) {
                  logger.error(`Error creating email index: ${err.message}`);
                  db.run('ROLLBACK');
                  return reject(err);
                }

                // Create user_sessions table
                db.run(`
                  CREATE TABLE IF NOT EXISTS user_sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    session_id TEXT UNIQUE NOT NULL,
                    token TEXT UNIQUE NOT NULL,
                    expires_at TIMESTAMP NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                  )
                `, (err) => {
                  if (err) {
                    logger.error(`Error creating user_sessions table: ${err.message}`);
                    db.run('ROLLBACK');
                    return reject(err);
                  }
                  logger.info('Created user_sessions table');

                  // Create indexes for user_sessions
                  db.run(`CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id)`, (err) => {
                    if (err) {
                      logger.error(`Error creating user_sessions user_id index: ${err.message}`);
                      db.run('ROLLBACK');
                      return reject(err);
                    }

                    db.run(`CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token)`, (err) => {
                      if (err) {
                        logger.error(`Error creating user_sessions token index: ${err.message}`);
                        db.run('ROLLBACK');
                        return reject(err);
                      }

                      // Check if user_id column exists in epg_matches
                      db.get(`PRAGMA table_info(epg_matches)`, (err, row) => {
                        if (err) {
                          logger.error(`Error checking epg_matches schema: ${err.message}`);
                          db.run('ROLLBACK');
                          return reject(err);
                        }

                        // Add user_id column to epg_matches if it doesn't exist
                        db.run(`
                          ALTER TABLE epg_matches ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
                        `, (err) => {
                          // Ignore error if column already exists
                          if (err && !err.message.includes('duplicate column')) {
                            logger.error(`Error adding user_id to epg_matches: ${err.message}`);
                            db.run('ROLLBACK');
                            return reject(err);
                          }
                          logger.info('Added user_id column to epg_matches table');

                          // Add user_id column to session_iptv_mappings if it doesn't exist
                          db.run(`
                            ALTER TABLE session_iptv_mappings ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
                          `, (err) => {
                            // Ignore error if column already exists
                            if (err && !err.message.includes('duplicate column')) {
                              logger.error(`Error adding user_id to session_iptv_mappings: ${err.message}`);
                              db.run('ROLLBACK');
                              return reject(err);
                            }
                            logger.info('Added user_id column to session_iptv_mappings table');

                            // Create index on user_id columns
                            db.run(`CREATE INDEX IF NOT EXISTS idx_epg_matches_user_id ON epg_matches(user_id)`, (err) => {
                              if (err) {
                                logger.error(`Error creating epg_matches user_id index: ${err.message}`);
                                db.run('ROLLBACK');
                                return reject(err);
                              }

                              db.run(`CREATE INDEX IF NOT EXISTS idx_session_iptv_mappings_user_id ON session_iptv_mappings(user_id)`, (err) => {
                                if (err) {
                                  logger.error(`Error creating session_iptv_mappings user_id index: ${err.message}`);
                                  db.run('ROLLBACK');
                                  return reject(err);
                                }

                                // Commit transaction
                                db.run('COMMIT', (err) => {
                                  if (err) {
                                    logger.error(`Error committing transaction: ${err.message}`);
                                    return reject(err);
                                  }

                                  logger.info('Migration completed successfully: Add User Authentication');
                                  db.close();
                                  resolve();
                                });
                              });
                            });
                          });
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}

/**
 * Rollback the migration
 * @returns {Promise<void>}
 */
async function down() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        logger.error(`Error connecting to database: ${err.message}`);
        return reject(err);
      }

      logger.info('Rolling back migration: Add User Authentication');

      db.serialize(() => {
        db.run('BEGIN TRANSACTION', (err) => {
          if (err) {
            logger.error(`Error starting transaction: ${err.message}`);
            return reject(err);
          }

          // Drop indexes
          db.run('DROP INDEX IF EXISTS idx_users_username', () => {
            db.run('DROP INDEX IF EXISTS idx_users_email', () => {
              db.run('DROP INDEX IF EXISTS idx_user_sessions_user_id', () => {
                db.run('DROP INDEX IF EXISTS idx_user_sessions_token', () => {
                  db.run('DROP INDEX IF EXISTS idx_epg_matches_user_id', () => {
                    db.run('DROP INDEX IF EXISTS idx_session_iptv_mappings_user_id', () => {
                      // Drop tables
                      db.run('DROP TABLE IF EXISTS user_sessions', () => {
                        db.run('DROP TABLE IF EXISTS users', () => {
                          // Note: Cannot remove columns from SQLite without recreating table
                          // We'll leave user_id columns in place for safety
                          logger.warn('Note: user_id columns remain in epg_matches and session_iptv_mappings (SQLite limitation)');

                          db.run('COMMIT', (err) => {
                            if (err) {
                              logger.error(`Error committing rollback: ${err.message}`);
                              return reject(err);
                            }

                            logger.info('Migration rollback completed: Add User Authentication');
                            db.close();
                            resolve();
                          });
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}

// Allow running migration directly
if (require.main === module) {
  const command = process.argv[2];

  if (command === 'up') {
    up()
      .then(() => {
        console.log('Migration completed successfully');
        process.exit(0);
      })
      .catch((err) => {
        console.error('Migration failed:', err);
        process.exit(1);
      });
  } else if (command === 'down') {
    down()
      .then(() => {
        console.log('Migration rollback completed successfully');
        process.exit(0);
      })
      .catch((err) => {
        console.error('Migration rollback failed:', err);
        process.exit(1);
      });
  } else {
    console.log('Usage: node 001_add_user_authentication.js [up|down]');
    process.exit(1);
  }
}

module.exports = { up, down };
