/**
 * Database Service for EPG Data
 * Uses SQLite for efficient EPG data storage and retrieval
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const logger = require('../config/logger');

// Database path
const DB_DIR = path.join(__dirname, '../data');
const DB_PATH = path.join(DB_DIR, 'epg.db');

// Ensure database directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// Initialize database connection
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    logger.error(`Error connecting to SQLite database: ${err.message}`);
  } else {
    logger.info('Connected to SQLite database');
  }
});

// Helper for promise-based SQLite queries
const run = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) {
        reject(err);
      } else {
        resolve({ lastID: this.lastID, changes: this.changes });
      }
    });
  });
};

const get = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
};

const all = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
};

const exec = (sql) => {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
};

// Initialize database tables
const initDatabase = async () => {
  try {
    // Enable foreign keys
    await run('PRAGMA foreign_keys = ON');
    
    // Create sources table
    await run(`
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT,
        file_path TEXT,
        channel_count INTEGER DEFAULT 0,
        program_count INTEGER DEFAULT 0,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create channels table
    await run(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        name TEXT NOT NULL,
        icon TEXT,
        FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
      )
    `);
    
    // Create programs table
    await run(`
      CREATE TABLE IF NOT EXISTS programs (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        start TIMESTAMP NOT NULL,
        stop TIMESTAMP NOT NULL,
        category TEXT,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      )
    `);
    
    // Create indexes for faster queries
    await run('CREATE INDEX IF NOT EXISTS idx_channel_source ON channels(source_id)');
    await run('CREATE INDEX IF NOT EXISTS idx_program_channel ON programs(channel_id)');
    await run('CREATE INDEX IF NOT EXISTS idx_program_start ON programs(start)');
    await run('CREATE INDEX IF NOT EXISTS idx_program_stop ON programs(stop)');
    
    logger.info('Database tables initialized');
  } catch (error) {
    logger.error(`Error initializing database: ${error.message}`);
    throw error;
  }
};

// Initialize the database on load
initDatabase().catch(err => {
  logger.error(`Failed to initialize database: ${err.message}`);
});

// Database service methods
const databaseService = {
  // Initialize database
  initDatabase,
  
  // Get database stats (counts)
  async getDatabaseStats() {
    try {
      // Count sources
      const sourcesCount = await get('SELECT COUNT(*) as count FROM sources');
      
      // Count channels
      const channelsCount = await get('SELECT COUNT(*) as count FROM channels');
      
      // Count programs
      const programsCount = await get('SELECT COUNT(*) as count FROM programs');
      
      return {
        sourceCount: sourcesCount ? sourcesCount.count : 0,
        channelCount: channelsCount ? channelsCount.count : 0,
        programCount: programsCount ? programsCount.count : 0,
        path: DB_PATH
      };
    } catch (error) {
      logger.error(`Error getting database stats: ${error.message}`);
      // Return empty stats on error to avoid crashing
      return {
        sourceCount: 0,
        channelCount: 0,
        programCount: 0,
        path: DB_PATH,
        error: error.message
      };
    }
  },
  
  // Get programs for a channel
  async getChannelPrograms(channelId, startTime, endTime) {
    try {
      // Get channel info
      const channelInfo = await this.getChannelById(channelId);
      
      if (!channelInfo) {
        throw new Error(`Channel not found: ${channelId}`);
      }
      
      // Default time window: next 24 hours
      const now = startTime || new Date();
      const tomorrow = endTime || new Date(now.getTime() + 24 * 60 * 60 * 1000);
      
      // Format dates for SQLite
      const startStr = now.toISOString();
      const endStr = tomorrow.toISOString();
      
      // Get programs for this channel in the time window
      const programs = await all(
        `SELECT * FROM programs 
         WHERE channel_id = ? 
         AND start <= ? 
         AND stop >= ? 
         ORDER BY start`,
        [channelId, endStr, startStr]
      );
      
      return {
        channelInfo,
        programs,
        timeWindow: {
          start: startStr,
          end: endStr
        }
      };
    } catch (error) {
      logger.error(`Error getting channel programs: ${error.message}`);
      throw error;
    }
  },
  
  // Source operations
  async addSource(source) {
    try {
      await run(
        'INSERT OR REPLACE INTO sources (id, name, url, file_path) VALUES (?, ?, ?, ?)',
        [source.id, source.name, source.url || null, source.filePath || null]
      );
      return source.id;
    } catch (error) {
      logger.error(`Error adding source: ${error.message}`);
      throw error;
    }
  },
  
  async updateSourceStats(sourceId, channelCount, programCount) {
    try {
      await run(
        'UPDATE sources SET channel_count = ?, program_count = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?',
        [channelCount, programCount, sourceId]
      );
    } catch (error) {
      logger.error(`Error updating source stats: ${error.message}`);
      throw error;
    }
  },
  
  async getAllSources() {
    try {
      return await all('SELECT * FROM sources ORDER BY name');
    } catch (error) {
      logger.error(`Error getting all sources: ${error.message}`);
      throw error;
    }
  },
  
  async getSourceById(sourceId) {
    try {
      return await get('SELECT * FROM sources WHERE id = ?', [sourceId]);
    } catch (error) {
      logger.error(`Error getting source by ID: ${error.message}`);
      throw error;
    }
  },
  
  // Channel operations
  async addChannel(channel) {
    try {
      await run(
        'INSERT OR REPLACE INTO channels (id, source_id, name, icon) VALUES (?, ?, ?, ?)',
        [channel.id, channel.sourceId, channel.name, channel.icon || null]
      );
      return channel.id;
    } catch (error) {
      logger.error(`Error adding channel: ${error.message}`);
      throw error;
    }
  },
  
  async addChannels(channels) {
    try {
      // Use a transaction for better performance
      await exec('BEGIN TRANSACTION');
      
      for (const channel of channels) {
        await run(
          'INSERT OR REPLACE INTO channels (id, source_id, name, icon) VALUES (?, ?, ?, ?)',
          [channel.id, channel.sourceId, channel.name, channel.icon || null]
        );
      }
      
      await exec('COMMIT');
      return channels.length;
    } catch (error) {
      await exec('ROLLBACK');
      logger.error(`Error adding channels in batch: ${error.message}`);
      throw error;
    }
  },
  
  async getChannelById(channelId) {
    try {
      return await get('SELECT c.*, s.name as source_name FROM channels c JOIN sources s ON c.source_id = s.id WHERE c.id = ?', [channelId]);
    } catch (error) {
      logger.error(`Error getting channel by ID: ${error.message}`);
      throw error;
    }
  },
  
  async getChannelsBySourceId(sourceId) {
    try {
      return await all('SELECT * FROM channels WHERE source_id = ?', [sourceId]);
    } catch (error) {
      logger.error(`Error getting channels by source ID: ${error.message}`);
      throw error;
    }
  },
  
  async searchChannels(query) {
    try {
      const searchTerm = `%${query}%`;
      return await all(
        `SELECT c.*, s.name as source_name 
         FROM channels c 
         JOIN sources s ON c.source_id = s.id 
         WHERE c.name LIKE ? 
         ORDER BY c.name 
         LIMIT 100`,
        [searchTerm]
      );
    } catch (error) {
      logger.error(`Error searching channels: ${error.message}`);
      throw error;
    }
  },
  
  // Program operations
  async addProgram(program) {
    try {
      await run(
        `INSERT OR REPLACE INTO programs 
         (id, channel_id, title, description, start, stop, category) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          program.id,
          program.channelId,
          program.title,
          program.description || null,
          program.start,
          program.stop,
          program.category || null
        ]
      );
      return program.id;
    } catch (error) {
      logger.error(`Error adding program: ${error.message}`);
      throw error;
    }
  },
  
  async addPrograms(programs) {
    try {
      // Use a transaction for better performance
      await exec('BEGIN TRANSACTION');
      
      for (const program of programs) {
        await run(
          `INSERT OR REPLACE INTO programs 
           (id, channel_id, title, description, start, stop, category) 
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            program.id,
            program.channelId,
            program.title,
            program.description || null,
            program.start,
            program.stop,
            program.category || null
          ]
        );
      }
      
      await exec('COMMIT');
      return programs.length;
    } catch (error) {
      await exec('ROLLBACK');
      logger.error(`Error adding programs in batch: ${error.message}`);
      throw error;
    }
  },
  
  async getProgramsByChannelId(channelId, startTime, endTime) {
    try {
      // Default time window: next 24 hours
      const now = startTime || new Date();
      const tomorrow = endTime || new Date(now.getTime() + 24 * 60 * 60 * 1000);
      
      // Format dates for SQLite
      const startStr = now.toISOString();
      const endStr = tomorrow.toISOString();
      
      return await all(
        `SELECT * FROM programs 
         WHERE channel_id = ? 
         AND start <= ? 
         AND stop >= ? 
         ORDER BY start
         LIMIT 100`,
        [channelId, endStr, startStr]
      );
    } catch (error) {
      logger.error(`Error getting programs by channel ID: ${error.message}`);
      throw error;
    }
  },
  
  // Close database connection
  close() {
    db.close();
  }
};

module.exports = databaseService; 