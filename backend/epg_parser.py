#!/usr/bin/env python3
"""
EPG Parser - Efficiently parses XMLTV data into SQLite database
Usage: python epg_parser.py [--sources SOURCE_FILE] [--db DB_PATH] [--force]
"""

import argparse
import gzip
import json
import logging
import os
import sqlite3
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path
from xml.sax import make_parser, handler

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler("epg_parser.log"),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger("epg_parser")

# Default paths
DEFAULT_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "epg.db")
DEFAULT_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")

# Default EPG sources (you can override with the --sources argument)
DEFAULT_EPG_SOURCES = [
    "https://strongepg.ip-ddns.com/epg/w-8k-epg.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz",
    "https://epg.pw/xmltv/epg_US.xml",
    "https://www.open-epg.com/files/unitedstates1.xml.gz",
    "https://open-epg.com/files/sports1.xml",
    "https://epg.starlite.best/utc.xml.gz",
    "https://raw.githubusercontent.com/acidjesuz/epgtalk/master/guide.xml",
    "https://i.mjh.nz/PlutoTV/us.xml.gz"
]

class TwoPassEPGParser:
    """Process EPG data in two passes to avoid foreign key issues"""
    
    def __init__(self, file_path, db_connection, source_id, source_name):
        self.file_path = file_path
        self.db = db_connection
        self.cursor = db_connection.cursor()
        self.source_id = source_id
        self.source_name = source_name
        
        # Statistics
        self.channel_count = 0
        self.program_count = 0
        self.skipped_programs = 0
        
        # Set to store channel IDs for the second pass
        self.channel_ids = set()
        
        # Check if file is gzipped
        self.is_gzipped = file_path.lower().endswith(".gz")
    
    def parse(self):
        """Process the EPG file in two passes"""
        logger.info(f"Starting first pass for {self.file_path}: extracting channels")
        self._first_pass()
        
        logger.info(f"Starting second pass for {self.file_path}: processing programs")
        self._second_pass()
        
        # Update source statistics - Fix: Use explicit timestamp instead of CURRENT_TIMESTAMP
        current_time = datetime.now().isoformat()
        try:
            self.cursor.execute(
                "UPDATE sources SET channel_count = ?, program_count = ?, last_updated = ? WHERE id = ?",
                (self.channel_count, self.program_count, current_time, self.source_id)
            )
            self.db.commit()
            logger.info(f"Updated source statistics: {self.channel_count} channels, {self.program_count} programs")
        except Exception as e:
            logger.error(f"Failed to update source statistics: {e}")
            self.db.rollback()
        
        logger.info(f"Completed parsing for {self.source_name}")
        logger.info(f"Extracted {self.channel_count} channels and {self.program_count} programs")
        if self.skipped_programs > 0:
            logger.warning(f"Skipped {self.skipped_programs} programs with unknown channels")
        
        return True
    
    def _first_pass(self):
        """First pass: extract and save all channels"""
        # Create first pass channel handler
        handler = ChannelHandler(self.db, self.source_id, self.source_name)
        
        # Create parser
        parser = make_parser()
        parser.setContentHandler(handler)
        
        # Parse the file
        try:
            if self.is_gzipped:
                with gzip.open(self.file_path, 'rb') as f:
                    parser.parse(f)
            else:
                parser.parse(self.file_path)
            
            # Update statistics
            self.channel_count = handler.channel_count
            
            # Get the channel IDs for the second pass
            self.channel_ids = handler.channel_ids
            
            logger.info(f"First pass complete: {self.channel_count} channels extracted")
            return True
        except Exception as e:
            logger.error(f"Error during first pass: {e}")
            return False
    
    def _second_pass(self):
        """Second pass: extract and save programs"""
        # Create second pass program handler
        handler = ProgramHandler(self.db, self.source_id, self.source_name, self.channel_ids)
        
        # Create parser
        parser = make_parser()
        parser.setContentHandler(handler)
        
        # Parse the file
        try:
            if self.is_gzipped:
                with gzip.open(self.file_path, 'rb') as f:
                    parser.parse(f)
            else:
                parser.parse(self.file_path)
            
            # Update statistics
            self.program_count = handler.program_count
            self.skipped_programs = handler.skipped_programs
            
            logger.info(f"Second pass complete: {self.program_count} programs extracted, {self.skipped_programs} skipped")
            return True
        except Exception as e:
            logger.error(f"Error during second pass: {e}")
            return False


class ChannelHandler(handler.ContentHandler):
    """First pass: SAX handler for extracting channels only"""
    
    def __init__(self, db_connection, source_id, source_name):
        self.db = db_connection
        self.cursor = db_connection.cursor()
        self.source_id = source_id
        self.source_name = source_name
        
        # Counters
        self.channel_count = 0
        self.last_progress_report = time.time()
        
        # Current element state
        self.current_element = None
        self.in_channel = False
        self.current_channel = {}
        self.buffer = ""
        
        # Channel tracking
        self.channel_batch = []
        self.channel_ids = set()
        
        # Batch size
        self.batch_size = 1000
    
    def startElement(self, name, attrs):
        self.current_element = name
        self.buffer = ""
        
        if name == "channel":
            self.in_channel = True
            self.current_channel = {
                "id": attrs.get("id", ""),
                "source_id": self.source_id,
                "name": "",
                "icon": None
            }
    
    def characters(self, content):
        self.buffer += content
    
    def endElement(self, name):
        if self.in_channel:
            if name == "display-name":
                self.current_channel["name"] = self.buffer.strip()
            elif name == "icon":
                # Only overwrite icon if we don't already have one and src attribute was handled
                if not self.current_channel["icon"] and "@src" in self.buffer:
                    self.current_channel["icon"] = self.buffer.strip()
            elif name == "channel":
                self.in_channel = False
                
                # Only process if we have a valid ID
                if self.current_channel["id"]:
                    self.channel_batch.append(self.current_channel)
                    self.channel_ids.add(self.current_channel["id"])
                    self.channel_count += 1
                    
                    # Process batch if needed
                    if len(self.channel_batch) >= self.batch_size:
                        self._process_channel_batch()
                        self._report_progress()
    
    def endDocument(self):
        # Process any remaining channels
        if self.channel_batch:
            self._process_channel_batch()
        
        logger.info(f"Processed {self.channel_count} channels from source {self.source_name}")
    
    def _process_channel_batch(self):
        """Process a batch of channels"""
        if not self.channel_batch:
            return
            
        try:
            # Insert all channels in a single transaction
            self.cursor.execute("BEGIN TRANSACTION")
            
            for channel in self.channel_batch:
                # Try to insert, and if it fails due to duplicate, update instead
                try:
                    self.cursor.execute(
                        "INSERT INTO channels (id, source_id, name, icon) VALUES (?, ?, ?, ?)",
                        (channel["id"], channel["source_id"], channel["name"], channel["icon"])
                    )
                except sqlite3.IntegrityError:
                    # Update existing channel
                    self.cursor.execute(
                        "UPDATE channels SET source_id = ?, name = ?, icon = ? WHERE id = ?",
                        (channel["source_id"], channel["name"], channel["icon"], channel["id"])
                    )
            
            self.cursor.execute("COMMIT")
            
            self.channel_batch = []
        except Exception as e:
            logger.error(f"Error processing channel batch: {e}")
            self.cursor.execute("ROLLBACK")
            self.channel_batch = []
    
    def _report_progress(self):
        """Report progress, but limit to once every 5 seconds"""
        now = time.time()
        if now - self.last_progress_report >= 5:
            logger.info(f"Progress: Processed {self.channel_count} channels")
            self.last_progress_report = now


class ProgramHandler(handler.ContentHandler):
    """Second pass: SAX handler for extracting programs only"""
    
    def __init__(self, db_connection, source_id, source_name, channel_ids):
        self.db = db_connection
        self.cursor = db_connection.cursor()
        self.source_id = source_id
        self.source_name = source_name
        
        # Channel IDs that actually exist in the database
        self.channel_ids = channel_ids
        
        # Counters
        self.program_count = 0
        self.skipped_programs = 0
        self.last_progress_report = time.time()
        
        # Current element state
        self.current_element = None
        self.in_programme = False
        self.current_program = {}
        self.buffer = ""
        
        # Batch processing
        self.program_batch = []
        self.batch_size = 1000
    
    def startElement(self, name, attrs):
        self.current_element = name
        self.buffer = ""
        
        if name == "programme":
            self.in_programme = True
            
            # Extract channel ID
            channel_id = attrs.get("channel", "")
            
            # Skip programs for channels we don't have
            if channel_id not in self.channel_ids:
                self.in_programme = False
                self.skipped_programs += 1
                return
            
            # Only process if we have required attributes
            self.current_program = {
                "channel_id": channel_id,
                "start": attrs.get("start", ""),
                "stop": attrs.get("stop", ""),
                "title": "",
                "description": None,
                "category": None
            }
            
            # Generate a unique ID for the program
            program_id = f"{channel_id}_{attrs.get('start', '')}_{attrs.get('stop', '')}"
            self.current_program["id"] = program_id
    
    def characters(self, content):
        self.buffer += content
    
    def endElement(self, name):
        if self.in_programme:
            if name == "title":
                self.current_program["title"] = self.buffer.strip()
            elif name == "desc":
                self.current_program["description"] = self.buffer.strip()
            elif name == "category":
                self.current_program["category"] = self.buffer.strip()
            elif name == "programme":
                self.in_programme = False
                
                # Only add if we have a title
                if self.current_program.get("title"):
                    self.program_batch.append(self.current_program)
                    self.program_count += 1
                    
                    # Process batch if needed
                    if len(self.program_batch) >= self.batch_size:
                        self._process_program_batch()
                        self._report_progress()
    
    def endDocument(self):
        # Process any remaining programs
        if self.program_batch:
            self._process_program_batch()
        
        logger.info(f"Processed {self.program_count} programs from source {self.source_name}")
        logger.info(f"Skipped {self.skipped_programs} programs with unknown channels")
    
    def _process_program_batch(self):
        """Process a batch of programs"""
        if not self.program_batch:
            return
            
        try:
            # Insert all programs in a single transaction
            self.cursor.execute("BEGIN TRANSACTION")
            
            for program in self.program_batch:
                try:
                    self.cursor.execute(
                        "INSERT OR REPLACE INTO programs (id, channel_id, title, description, start, stop, category) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (program["id"], program["channel_id"], program["title"], 
                         program["description"], program["start"], program["stop"], 
                         program["category"])
                    )
                except sqlite3.IntegrityError as e:
                    # Log details about the error for diagnosis
                    logger.error(f"IntegrityError for program: {program['id']}, channel: {program['channel_id']}")
                    # Continue with next program
                    continue
            
            self.cursor.execute("COMMIT")
            
            self.program_batch = []
        except Exception as e:
            logger.error(f"Error processing program batch: {e}")
            self.cursor.execute("ROLLBACK")
            self.program_batch = []
    
    def _report_progress(self):
        """Report progress, but limit to once every 5 seconds"""
        now = time.time()
        if now - self.last_progress_report >= 5:
            logger.info(f"Progress: Processed {self.program_count} programs, skipped {self.skipped_programs}")
            self.last_progress_report = now


def init_database(db_path):
    """Initialize the SQLite database with tables and indexes"""
    # Ensure db directory exists
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    
    # Connect to database
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row  # Use row factory for better row access
    
    cursor = conn.cursor()
    
    # Enable foreign keys
    cursor.execute("PRAGMA foreign_keys = ON")
    
    # Create tables if they don't exist
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT,
        file_path TEXT,
        channel_count INTEGER DEFAULT 0,
        program_count INTEGER DEFAULT 0,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """)
    
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        name TEXT NOT NULL,
        icon TEXT,
        FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
    )
    """)
    
    cursor.execute("""
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
    """)
    
    # Create indexes for faster querying
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_channel_source ON channels(source_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_channel_name ON channels(name)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_program_channel ON programs(channel_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_program_start ON programs(start)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_program_stop ON programs(stop)")
    
    conn.commit()
    logger.info(f"Database initialized at {db_path}")
    
    return conn


def download_file(url, cache_dir):
    """Download a file from URL to cache directory, return the local path"""
    # Create cache dir if it doesn't exist
    os.makedirs(cache_dir, exist_ok=True)
    
    # Generate a safe filename
    url_hash = url.replace('/', '_').replace(':', '_').replace('.', '_')
    if len(url_hash) > 100:
        import hashlib
        url_hash = hashlib.md5(url.encode('utf-8')).hexdigest()
    
    filename = f"{url_hash}.xml"
    if url.lower().endswith(".gz"):
        filename += ".gz"
    
    local_path = os.path.join(cache_dir, filename)
    
    # Check if we have a cached version less than 24 hours old
    if os.path.exists(local_path):
        file_age = time.time() - os.path.getmtime(local_path)
        if file_age < 24 * 60 * 60:  # 24 hours
            logger.info(f"Using cached file for {url}")
            return local_path
    
    # Download the file
    try:
        logger.info(f"Downloading {url} to {local_path}")
        
        # Set appropriate headers
        headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) EPGParser/1.0',
            'Accept': '*/*'
        }
        
        req = urllib.request.Request(url, headers=headers)
        
        with urllib.request.urlopen(req) as response, open(local_path, 'wb') as out_file:
            chunk_size = 1024 * 1024  # 1MB chunks
            total_size = int(response.info().get('Content-Length', 0))
            downloaded = 0
            
            while True:
                chunk = response.read(chunk_size)
                if not chunk:
                    break
                
                out_file.write(chunk)
                downloaded += len(chunk)
                
                if total_size > 0:
                    percent = int(downloaded * 100 / total_size)
                    if percent % 10 == 0:  # Report every 10%
                        logger.info(f"Downloaded {downloaded/1024/1024:.1f}MB of {total_size/1024/1024:.1f}MB ({percent}%)")
                else:
                    if downloaded % (10 * 1024 * 1024) == 0:  # Report every 10MB
                        logger.info(f"Downloaded {downloaded/1024/1024:.1f}MB")
        
        logger.info(f"Download complete: {local_path}")
        return local_path
    except Exception as e:
        logger.error(f"Error downloading {url}: {e}")
        # If download fails but we have an old cached version, use that
        if os.path.exists(local_path):
            logger.warning(f"Using older cached version of {url}")
            return local_path
        return None


def parse_epg_file(file_path, db_connection, source_id, source_name):
    """Parse an EPG file (XML, possibly gzipped) into the database"""
    logger.info(f"Parsing EPG file: {file_path} (source: {source_name})")
    
    # Use our two-pass parser
    parser = TwoPassEPGParser(file_path, db_connection, source_id, source_name)
    
    try:
        return parser.parse()
    except Exception as e:
        logger.error(f"Error parsing {file_path}: {e}")
        return False


def process_source(source_url, db_connection, cache_dir, force=False):
    """Process a single EPG source"""
    logger.info(f"Processing EPG source: {source_url}")
    
    # Generate source ID and name
    import hashlib
    source_id = hashlib.md5(source_url.encode('utf-8')).hexdigest()
    source_name = source_url.split("/")[-1]
    
    # Delete any existing data for this source to start fresh
    cursor = db_connection.cursor()
    cursor.execute("PRAGMA foreign_keys = ON") # Enable foreign keys to ensure cascade delete
    
    # If source exists, delete it first (this will cascade delete all related channels and programs)
    cursor.execute("DELETE FROM sources WHERE id = ?", (source_id,))
    db_connection.commit()
    logger.info(f"Deleted existing data for source: {source_name}")
    
    # Download the file if it's a URL
    if source_url.startswith("http"):
        local_path = download_file(source_url, cache_dir)
        if not local_path:
            return False
    else:
        local_path = source_url
    
    # Add source to database before parsing
    cursor.execute(
        "INSERT INTO sources (id, name, url, channel_count, program_count) VALUES (?, ?, ?, 0, 0)",
        (source_id, source_name, source_url)
    )
    db_connection.commit()
    
    # Parse the file
    success = parse_epg_file(local_path, db_connection, source_id, source_name)
    
    return success


def read_sources_file(file_path):
    """Read sources from a JSON or text file"""
    try:
        if file_path.endswith(".json"):
            with open(file_path, 'r') as f:
                data = json.load(f)
                if isinstance(data, list):
                    return data
                elif isinstance(data, dict) and "EXTERNAL_EPG_URLS" in data:
                    return data["EXTERNAL_EPG_URLS"]
                else:
                    logger.error(f"Invalid source file format in {file_path}")
                    return []
        else:
            with open(file_path, 'r') as f:
                return [line.strip() for line in f if line.strip() and not line.startswith("#")]
    except Exception as e:
        logger.error(f"Error reading sources file {file_path}: {e}")
        return []


def get_db_statistics(db_path):
    """Get statistics about the database contents"""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    stats = {
        "sources": 0,
        "channels": 0,
        "programs": 0,
        "source_details": []
    }
    
    # Get source counts
    cursor.execute("SELECT COUNT(*) FROM sources")
    stats["sources"] = cursor.fetchone()[0]
    
    # Get channel counts
    cursor.execute("SELECT COUNT(*) FROM channels")
    stats["channels"] = cursor.fetchone()[0]
    
    # Get program counts
    cursor.execute("SELECT COUNT(*) FROM programs")
    stats["programs"] = cursor.fetchone()[0]
    
    # Get details per source
    cursor.execute("""
        SELECT s.name, s.channel_count, s.program_count, s.last_updated, s.url
        FROM sources s
        ORDER BY s.channel_count DESC
    """)
    
    for row in cursor.fetchall():
        last_updated = datetime.fromisoformat(row["last_updated"].replace('Z', '+00:00'))
        age_in_hours = (datetime.now() - last_updated).total_seconds() / 3600
        
        stats["source_details"].append({
            "name": row["name"],
            "channel_count": row["channel_count"],
            "program_count": row["program_count"],
            "last_updated": last_updated,
            "age_hours": age_in_hours,
            "url": row["url"]
        })
    
    conn.close()
    return stats


def print_db_statistics(db_path):
    """Print formatted database statistics"""
    stats = get_db_statistics(db_path)
    
    print("\n" + "="*80)
    print(f"  EPG DATABASE STATISTICS ({db_path})")
    print("="*80)
    print(f"  Total Sources:  {stats['sources']}")
    print(f"  Total Channels: {stats['channels']}")
    print(f"  Total Programs: {stats['programs']:,}")
    print("-"*80)
    
    if stats['source_details']:
        print("  SOURCES BREAKDOWN:")
        print("  {:<30} {:<10} {:<15} {:<15}".format("Source", "Channels", "Programs", "Last Updated"))
        print("  " + "-"*70)
        
        for src in stats["source_details"]:
            update_time = src["last_updated"].strftime("%Y-%m-%d %H:%M")
            age_text = f"({src['age_hours']:.1f} hours ago)"
            print("  {:<30} {:<10,} {:<15,} {:<15} {}".format(
                src["name"][:30], 
                src["channel_count"], 
                src["program_count"], 
                update_time,
                age_text
            ))
    else:
        print("  No sources found in the database.")
    
    print("="*80 + "\n")


def show_interactive_menu(db_path, cache_dir):
    """Show an interactive menu for EPG management"""
    while True:
        print("\n" + "="*80)
        print("  EPG PARSER MENU")
        print("="*80)
        print("  1. Update All EPG Sources (Normal Mode)")
        print("  2. Force Update All EPG Sources")
        print("  3. Update a Specific EPG Source")
        print("  4. Show Database Statistics")
        print("  5. Search for Channel by Name")
        print("  6. Delete a Source and its Data")
        print("  7. Optimize Database")
        print("  0. Exit")
        print("="*80)
        
        choice = input("\nEnter your choice (0-7): ").strip()
        
        if choice == "0":
            print("Exiting EPG Parser. Goodbye!")
            break
            
        elif choice == "1":
            # Normal update
            print("\nUpdating EPG sources (normal mode - skips sources updated in last 24 hours)...")
            run_parser(db_path, cache_dir, force=False)
            
        elif choice == "2":
            # Force update
            print("\nForce updating ALL EPG sources (ignores 24-hour rule)...")
            run_parser(db_path, cache_dir, force=True)
            
        elif choice == "3":
            # Update specific source
            sources = DEFAULT_EPG_SOURCES
            print("\nAvailable EPG Sources:")
            for i, src in enumerate(sources):
                print(f"  {i+1}. {src}")
            
            try:
                src_idx = int(input("\nEnter source number to update (or 0 to cancel): ").strip()) - 1
                if 0 <= src_idx < len(sources):
                    print(f"\nUpdating source: {sources[src_idx]}")
                    process_single_source(sources[src_idx], db_path, cache_dir)
            except ValueError:
                print("Invalid selection. Please enter a number.")
            
        elif choice == "4":
            # Show statistics
            print_db_statistics(db_path)
            
        elif choice == "5":
            # Search for channel
            search_term = input("\nEnter channel name to search for: ").strip()
            if search_term:
                search_channels(db_path, search_term)
            
        elif choice == "6":
            # Delete a source
            delete_source(db_path)
            
        elif choice == "7":
            # Optimize database
            print("\nOptimizing database...")
            optimize_database(db_path)
            
        else:
            print("Invalid choice. Please try again.")
        
        input("\nPress Enter to continue...")


def search_channels(db_path, search_term):
    """Search for channels by name"""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Search for channels
    cursor.execute("""
        SELECT c.id, c.name, c.icon, s.name as source_name, 
               (SELECT COUNT(*) FROM programs WHERE channel_id = c.id) as program_count
        FROM channels c
        JOIN sources s ON c.source_id = s.id
        WHERE c.name LIKE ? 
        ORDER BY c.name
        LIMIT 100
    """, (f"%{search_term}%",))
    
    results = cursor.fetchall()
    
    print(f"\nFound {len(results)} channels matching '{search_term}':")
    if results:
        print("\n  {:<40} {:<15} {:<10}".format("Channel Name", "Source", "Programs"))
        print("  " + "-"*70)
        for row in results:
            print("  {:<40} {:<15} {:<10,}".format(
                row["name"][:40], 
                row["source_name"][:15],
                row["program_count"]
            ))
    else:
        print("  No channels found.")
    
    conn.close()


def delete_source(db_path):
    """Delete a source and all its data"""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Get all sources
    cursor.execute("SELECT id, name, channel_count, program_count FROM sources ORDER BY name")
    sources = cursor.fetchall()
    
    if not sources:
        print("\nNo sources found in the database.")
        conn.close()
        return
    
    print("\nAvailable sources:")
    for i, src in enumerate(sources):
        print(f"  {i+1}. {src['name']} ({src['channel_count']} channels, {src['program_count']} programs)")
    
    try:
        src_idx = int(input("\nEnter source number to DELETE (or 0 to cancel): ").strip()) - 1
        if 0 <= src_idx < len(sources):
            source_id = sources[src_idx]["id"]
            source_name = sources[src_idx]["name"]
            
            confirm = input(f"\nAre you sure you want to DELETE '{source_name}' and all its data? (y/n): ").lower()
            if confirm == 'y':
                # Enable foreign keys to ensure cascade delete works
                cursor.execute("PRAGMA foreign_keys = ON")
                
                # Delete the source (this will cascade to channels and programs)
                cursor.execute("DELETE FROM sources WHERE id = ?", (source_id,))
                conn.commit()
                
                print(f"\nDeleted source '{source_name}' and all its data.")
            else:
                print("\nDeletion cancelled.")
        elif src_idx == -1:
            print("\nDeletion cancelled.")
        else:
            print("\nInvalid selection.")
    except ValueError:
        print("\nInvalid selection. Please enter a number.")
    
    conn.close()


def optimize_database(db_path):
    """Optimize the database by vacuuming it"""
    print("\nOptimizing database. This may take a few minutes for large databases...")
    
    conn = sqlite3.connect(db_path)
    start_time = time.time()
    
    # Get the file size before optimization
    try:
        size_before = os.path.getsize(db_path) / (1024 * 1024)  # Size in MB
    except:
        size_before = 0
    
    # Run VACUUM to optimize the database
    conn.execute("VACUUM")
    conn.close()
    
    # Get the file size after optimization
    try:
        size_after = os.path.getsize(db_path) / (1024 * 1024)  # Size in MB
    except:
        size_after = 0
    
    elapsed = time.time() - start_time
    
    print(f"\nDatabase optimization complete!")
    print(f"  Time taken: {elapsed:.1f} seconds")
    print(f"  Size before: {size_before:.1f} MB")
    print(f"  Size after:  {size_after:.1f} MB")
    print(f"  Space saved: {size_before - size_after:.1f} MB")


def process_single_source(source_url, db_path, cache_dir):
    """Process a single EPG source from the interactive menu"""
    # Initialize database
    db_connection = init_database(db_path)
    
    # Process the source with force=True to ensure it's processed
    success = process_source(source_url, db_connection, cache_dir, force=True)
    
    # Close database connection
    db_connection.close()
    
    if success:
        print(f"Successfully processed source: {source_url}")
    else:
        print(f"Failed to process source: {source_url}")


def run_parser(db_path, cache_dir, force=False):
    """Run the parser with the given options"""
    # Initialize database
    db_connection = init_database(db_path)
    
    # Process each source
    sources = DEFAULT_EPG_SOURCES
    start_time = time.time()
    success_count = 0
    
    try:
        for idx, source in enumerate(sources):
            print(f"Processing source {idx+1}/{len(sources)}: {source}")
            if process_source(source, db_connection, cache_dir, force):
                success_count += 1
    except KeyboardInterrupt:
        print("\nProcess interrupted by user, cleaning up...")
        # Ensure we commit any pending transactions
        try:
            db_connection.commit()
        except:
            pass
    finally:
        # Close database connection
        db_connection.close()
        
        # Final report
        elapsed = time.time() - start_time
        print(f"\nEPG parsing complete! Processed {success_count}/{len(sources)} sources in {elapsed:.1f} seconds")
        
        # Optimize the database
        optimize_database(db_path)


def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(description="EPG Parser for XMLTV data")
    parser.add_argument("--sources", help="Path to file containing EPG sources (JSON or text)")
    parser.add_argument("--db", default=DEFAULT_DB_PATH, help=f"SQLite database path (default: {DEFAULT_DB_PATH})")
    parser.add_argument("--cache", default=DEFAULT_CACHE_DIR, help=f"Cache directory for downloaded files (default: {DEFAULT_CACHE_DIR})")
    parser.add_argument("--force", action="store_true", help="Force process all sources even if recently updated")
    parser.add_argument("--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"], help="Set the logging level")
    parser.add_argument("--source", help="Process only a specific source URL")
    parser.add_argument("--no-menu", action="store_true", help="Run in command-line mode without showing the interactive menu")
    args = parser.parse_args()
    
    # Set log level
    logger.setLevel(getattr(logging, args.log_level))
    
    # Determine sources
    sources = []
    
    if args.source:
        # Process a single source
        sources = [args.source]
    elif args.sources:
        # Load from sources file
        loaded_sources = read_sources_file(args.sources)
        if loaded_sources:
            sources = loaded_sources
            logger.info(f"Loaded {len(sources)} sources from {args.sources}")
    else:
        # Use default sources
        sources = DEFAULT_EPG_SOURCES
    
    # Show database statistics at startup
    if os.path.exists(args.db):
        try:
            print_db_statistics(args.db)
        except Exception as e:
            logger.error(f"Error displaying database statistics: {e}")
    else:
        print(f"\nNo EPG database found at {args.db}. A new one will be created when needed.")
    
    # Check if we should show the interactive menu or run in command line mode
    if args.no_menu or args.source or args.sources or args.force:
        # Run in command line mode
        logger.info(f"Starting EPG Parser with {len(sources)} sources")
        logger.info(f"Database: {args.db}")
        logger.info(f"Cache directory: {args.cache}")
        
        # Initialize database
        db_connection = init_database(args.db)
        
        # Process each source
        start_time = time.time()
        success_count = 0
        
        try:
            for idx, source in enumerate(sources):
                logger.info(f"Processing source {idx+1}/{len(sources)}: {source}")
                if process_source(source, db_connection, args.cache, args.force):
                    success_count += 1
        except KeyboardInterrupt:
            logger.warning("Process interrupted by user, cleaning up...")
            # Ensure we commit any pending transactions
            try:
                db_connection.commit()
            except:
                pass
        finally:
            # Close database connection
            db_connection.close()
            
            # Final report
            elapsed = time.time() - start_time
            logger.info(f"EPG parsing complete! Processed {success_count}/{len(sources)} sources in {elapsed:.1f} seconds")
            
            # Vacuum the database to optimize storage
            logger.info(f"Optimizing database...")
            db_connection = sqlite3.connect(args.db)
            db_connection.execute("VACUUM")
            db_connection.close()
            logger.info(f"Database optimization complete")
    else:
        # Show interactive menu
        try:
            show_interactive_menu(args.db, args.cache)
        except KeyboardInterrupt:
            print("\nEPG Parser exited. Goodbye!")


if __name__ == "__main__":
    main()
