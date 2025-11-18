const mongoose = require('mongoose');
const logger = require('../config/logger');

// Define schemas
const EpgSourceSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  url: String,
  filePath: String,
  channelCount: { type: Number, default: 0 },
  programCount: { type: Number, default: 0 },
  lastUpdated: { type: Date, default: Date.now }
});

const EpgChannelSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  sourceId: { type: String, required: true },
  name: { type: String, required: true },
  icon: String,
  languageCode: String,
  categoriesCSV: String,
  lastUpdated: { type: Date, default: Date.now }
});

// Index for faster searching
EpgChannelSchema.index({ name: 'text' });
EpgChannelSchema.index({ sourceId: 1 });

const EpgProgramSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  channelId: { type: String, required: true },
  sourceId: { type: String, required: true },
  title: { type: String, required: true },
  description: String,
  start: { type: Date, required: true },
  stop: { type: Date, required: true },
  categories: [String],
  lastUpdated: { type: Date, default: Date.now }
});

// Indexes for faster querying
EpgProgramSchema.index({ channelId: 1, start: 1, stop: 1 });
EpgProgramSchema.index({ sourceId: 1 });

// Create models
const EpgSource = mongoose.model('EpgSource', EpgSourceSchema);
const EpgChannel = mongoose.model('EpgChannel', EpgChannelSchema);
const EpgProgram = mongoose.model('EpgProgram', EpgProgramSchema);

const epgDatabaseService = {
  /**
   * Initialize database connection
   */
  async init() {
    // Check if already connected
    if (mongoose.connection.readyState === 1) {
      logger.info('MongoDB already connected');
      return;
    }

    try {
      const connectionString = process.env.MONGODB_URI || 'mongodb://localhost:27017/iptv-epg-matcher';
      await mongoose.connect(connectionString);
      logger.info('Connected to MongoDB for EPG data');
    } catch (error) {
      logger.error(`MongoDB connection error: ${error.message}`);
      throw error;
    }
  },

  /**
   * Save EPG source data
   */
  async saveSource(source) {
    try {
      await this.init();
      
      const existingSource = await EpgSource.findOne({ id: source.id });
      
      if (existingSource) {
        // Update existing source
        return await EpgSource.findOneAndUpdate(
          { id: source.id },
          { 
            ...source, 
            lastUpdated: Date.now()
          },
          { new: true }
        );
      } else {
        // Create new source
        const newSource = new EpgSource({
          ...source,
          lastUpdated: Date.now()
        });
        return await newSource.save();
      }
    } catch (error) {
      logger.error(`Error saving EPG source: ${error.message}`);
      throw error;
    }
  },

  /**
   * Save EPG channel data
   */
  async saveChannel(channel) {
    try {
      await this.init();
      
      const existingChannel = await EpgChannel.findOne({ id: channel.id });
      
      if (existingChannel) {
        // Update existing channel
        return await EpgChannel.findOneAndUpdate(
          { id: channel.id },
          { 
            ...channel, 
            lastUpdated: Date.now()
          },
          { new: true }
        );
      } else {
        // Create new channel
        const newChannel = new EpgChannel({
          ...channel,
          lastUpdated: Date.now()
        });
        return await newChannel.save();
      }
    } catch (error) {
      logger.error(`Error saving EPG channel: ${error.message}`);
      throw error;
    }
  },

  /**
   * Save EPG program data
   */
  async saveProgram(program) {
    try {
      await this.init();
      
      const existingProgram = await EpgProgram.findOne({ id: program.id });
      
      if (existingProgram) {
        // Update existing program
        return await EpgProgram.findOneAndUpdate(
          { id: program.id },
          { 
            ...program, 
            lastUpdated: Date.now()
          },
          { new: true }
        );
      } else {
        // Create new program
        const newProgram = new EpgProgram({
          ...program,
          lastUpdated: Date.now()
        });
        return await newProgram.save();
      }
    } catch (error) {
      logger.error(`Error saving EPG program: ${error.message}`);
      throw error;
    }
  },

  /**
   * Save multiple channels in bulk
   */
  async saveChannels(channels) {
    try {
      await this.init();
      
      // Use bulk operations for better performance
      const bulkOps = channels.map(channel => ({
        updateOne: {
          filter: { id: channel.id },
          update: { 
            ...channel,
            lastUpdated: Date.now()
          },
          upsert: true
        }
      }));
      
      if (bulkOps.length > 0) {
        return await EpgChannel.bulkWrite(bulkOps);
      }
      return { acknowledged: true, modifiedCount: 0 };
    } catch (error) {
      logger.error(`Error bulk saving EPG channels: ${error.message}`);
      throw error;
    }
  },

  /**
   * Save multiple programs in bulk
   */
  async savePrograms(programs) {
    try {
      await this.init();
      
      // Use bulk operations for better performance
      const bulkOps = programs.map(program => ({
        updateOne: {
          filter: { id: program.id },
          update: { 
            ...program,
            lastUpdated: Date.now()
          },
          upsert: true
        }
      }));
      
      if (bulkOps.length > 0) {
        return await EpgProgram.bulkWrite(bulkOps);
      }
      return { acknowledged: true, modifiedCount: 0 };
    } catch (error) {
      logger.error(`Error bulk saving EPG programs: ${error.message}`);
      throw error;
    }
  },

  /**
   * Get EPG sources
   */
  async getSources() {
    try {
      await this.init();
      return await EpgSource.find();
    } catch (error) {
      logger.error(`Error getting EPG sources: ${error.message}`);
      throw error;
    }
  },

  /**
   * Get EPG channels for a source
   */
  async getChannelsBySourceId(sourceId) {
    try {
      await this.init();
      return await EpgChannel.find({ sourceId });
    } catch (error) {
      logger.error(`Error getting EPG channels for source ${sourceId}: ${error.message}`);
      throw error;
    }
  },

  /**
   * Get all EPG channels
   */
  async getAllChannels() {
    try {
      await this.init();
      return await EpgChannel.find();
    } catch (error) {
      logger.error(`Error getting all EPG channels: ${error.message}`);
      throw error;
    }
  },

  /**
   * Get EPG channel by ID
   */
  async getChannelById(channelId) {
    try {
      await this.init();
      const channel = await EpgChannel.findOne({ id: channelId });
      
      if (!channel) {
        return null;
      }
      
      // Also get the source information
      const source = await EpgSource.findOne({ id: channel.sourceId });
      
      return {
        id: channel.id,
        sourceId: channel.sourceId,
        name: channel.name,
        icon: channel.icon,
        source_name: source ? source.name : 'Unknown Source'
      };
    } catch (error) {
      logger.error(`Error getting EPG channel by ID ${channelId}: ${error.message}`);
      throw error;
    }
  },
  
  /**
   * Get programs for a channel within a time window
   */
  async getProgramsByChannelId(channelId, startTime, endTime) {
    try {
      await this.init();
      
      // Default time window if not provided: next 24 hours
      const now = startTime || new Date();
      const tomorrow = endTime || new Date(now.getTime() + 24 * 60 * 60 * 1000);
      
      const programs = await EpgProgram.find({
        channelId: channelId,
        start: { $lte: tomorrow },
        stop: { $gte: now }
      }).sort({ start: 1 }).limit(100);
      
      return programs.map(program => ({
        id: program.id,
        channelId: program.channelId,
        title: program.title,
        description: program.description,
        start: program.start,
        stop: program.stop,
        categories: program.categories
      }));
    } catch (error) {
      logger.error(`Error getting programs for channel ${channelId}: ${error.message}`);
      throw error;
    }
  },
  
  /**
   * Get total channel count
   */
  async getChannelCount() {
    try {
      await this.init();
      return await EpgChannel.countDocuments();
    } catch (error) {
      logger.error(`Error getting channel count: ${error.message}`);
      throw error;
    }
  },
  
  /**
   * Get total program count
   */
  async getProgramCount() {
    try {
      await this.init();
      return await EpgProgram.countDocuments();
    } catch (error) {
      logger.error(`Error getting program count: ${error.message}`);
      throw error;
    }
  },
  
  /**
   * Search channels by query
   */
  async searchChannels(query) {
    try {
      await this.init();
      
      // Normalize the search term
      const searchTerm = query.toLowerCase().trim();
      
      // Create a regex for partial matching
      const searchRegex = new RegExp(searchTerm, 'i');
      
      // Use MongoDB text search with fallback to regex
      const channels = await EpgChannel.find({
        $or: [
          { name: searchRegex },
          { id: searchRegex }
        ]
      }).limit(100);
      
      // Get source information for each channel
      const result = [];
      for (const channel of channels) {
        const source = await EpgSource.findOne({ id: channel.sourceId });
        result.push({
          id: channel.id,
          sourceId: channel.sourceId,
          name: channel.name,
          icon: channel.icon,
          source_name: source ? source.name : 'Unknown Source'
        });
      }
      
      return result;
    } catch (error) {
      logger.error(`Error searching EPG channels with query "${query}": ${error.message}`);
      throw error;
    }
  },

  /**
   * Get EPG statistics
   */
  async getStats() {
    try {
      await this.init();
      
      const sourceCount = await EpgSource.countDocuments();
      const channelCount = await EpgChannel.countDocuments();
      const programCount = await EpgProgram.countDocuments();
      
      return {
        sources: sourceCount,
        channels: channelCount,
        programs: programCount
      };
    } catch (error) {
      logger.error(`Error getting EPG stats: ${error.message}`);
      throw error;
    }
  },

  /**
   * Clear all EPG data for a source
   */
  async clearSourceData(sourceId) {
    try {
      await this.init();
      
      // First get all channelIds for this source
      const channels = await EpgChannel.find({ sourceId }, { id: 1 });
      const channelIds = channels.map(channel => channel.id);
      
      // Delete programs for these channels
      await EpgProgram.deleteMany({ channelId: { $in: channelIds } });
      
      // Delete channels
      await EpgChannel.deleteMany({ sourceId });
      
      // Delete source
      await EpgSource.deleteOne({ id: sourceId });
      
      return {
        deletedSource: sourceId,
        deletedChannels: channels.length,
        deletedPrograms: channelIds.length > 0 ? 'multiple' : 0
      };
    } catch (error) {
      logger.error(`Error clearing data for source ${sourceId}: ${error.message}`);
      throw error;
    }
  },

  /**
   * Clear all EPG data from database
   */
  async clearAllData() {
    try {
      await this.init();
      
      await EpgProgram.deleteMany({});
      await EpgChannel.deleteMany({});
      await EpgSource.deleteMany({});
      
      return { success: true, message: 'All EPG data cleared' };
    } catch (error) {
      logger.error(`Error clearing all EPG data: ${error.message}`);
      throw error;
    }
  }
};

module.exports = epgDatabaseService; 