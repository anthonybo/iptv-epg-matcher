# IPTV EPG Matcher

A powerful web application for matching IPTV channels with EPG (Electronic Program Guide) data, with live stream playback capability.

## Overview

IPTV EPG Matcher allows you to:
- Load IPTV channels from various sources (M3U files, URLs, or Xtream API)
- Auto-match or manually match channels with EPG data
- Watch live TV streams directly in your browser
- Generate new Xtream credentials with properly matched EPG data

This tool solves the common problem of mismatched or missing EPG data in IPTV services by providing an intuitive interface to correct and enhance channel metadata.

## Features

- **Multiple Source Support**: Load channels from M3U files, URLs, or Xtream API credentials
- **Automatic EPG Matching**: Smart algorithms to suggest matching EPG IDs for channels
- **Multiple Player Options**: HLS, TS, and VLC link support for maximum compatibility
- **EPG Preview**: View current and upcoming programs for matched channels
- **Channel Filtering**: Browse channels by category or search by name
- **Session Management**: Persistent sessions to save your work
- **Modern UI**: Responsive, user-friendly interface built with React

## Installation

### Prerequisites

- Node.js (v14.x or higher)
- npm or yarn

### Backend Setup

```bash
# Navigate to backend directory
cd backend

# Install dependencies
npm install

# Create necessary directories
mkdir -p uploads logs cache

# Start the server
npm start
