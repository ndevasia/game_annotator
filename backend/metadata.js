const fs = require('fs');
const path = require('path');

class SessionMetadata {
  constructor(title = '', username = '', fileTimestamp = null, videoStartTimestamp = null) {
    this.title = title;
    this.username = username;
    this.fileTimestamp = fileTimestamp || this.getFormattedTimestamp();
    this.videoStartTimestamp = videoStartTimestamp;

    // Try to load username from config.json if not provided
    if (this.username=='') {
      const configPath = path.join(__dirname, 'config.json');
      if (fs.existsSync(configPath)) {
        try {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          if (config.username && typeof config.username === 'string') {
            this.username = config.username;
          }
        } catch (err) {
          console.warn('⚠️ Failed to read or parse config.json:', err);
        }
      }
    }
  }

  getFormattedTimestamp() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = now.getFullYear();
    const MM = pad(now.getMonth() + 1);
    const dd = pad(now.getDate());
    const hh = pad(now.getHours());
    const mm = pad(now.getMinutes());
    const ss = pad(now.getSeconds());
    return `${yyyy}-${MM}-${dd} ${hh}-${mm}-${ss}`;
}
  // Setters
  setTitle(title) {
    this.title = title;
  }

  setUsername(username) {
    this.username = username;
  }

  setFileTimestamp(fileTimestamp) {
    this.fileTimestamp = fileTimestamp;
  }

  setVideoStartTimestamp(timestamp) {
    this.videoStartTimestamp = timestamp;
  }

  // Getters
  getTitle() {
    return this.title;
  }

  getUsername() {
    return this.username;
  }

  getFileTimestamp() {
    return this.fileTimestamp;
  }

  getVideoStartTimestamp() {
    return this.videoStartTimestamp;
  }

  toJSON() {
    return {
      username: this.username,
      title: this.title,
      fileTimestamp: this.fileTimestamp,
      videoStartTimestamp: this.videoStartTimestamp,
    };
  }
}

module.exports = SessionMetadata;
