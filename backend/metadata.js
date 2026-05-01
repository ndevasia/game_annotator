const fs = require('fs');
const path = require('path');

class SessionMetadata {
  constructor(title = '', username = '', fileTimestamp = null, videoStartTimestamp = null) {
    this.title = title;
    this.username = username;
    this.fileTimestamp = fileTimestamp || this.getFormattedTimestamp();
    this.videoStartTimestamp = videoStartTimestamp;
    this.postGameReview = '';
    this.postGameReviewSavedAt = null;
    this.postGameReviewLastEditedAt = null;

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
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${yyyy}-${MM}-${dd} ${hh}-${mm}-${ss}-${ms}`;
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

  setPostGameReview(review) {
    this.postGameReview = review || '';
    if (!this.postGameReview) {
      this.postGameReviewSavedAt = null;
      this.postGameReviewLastEditedAt = null;
      return;
    }

    const now = Date.now();
    if (!this.postGameReviewSavedAt) {
      this.postGameReviewSavedAt = now;
    }
    this.postGameReviewLastEditedAt = now;
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

  getPostGameReview() {
    return this.postGameReview;
  }

  getPostGameReviewSavedAt() {
    return this.postGameReviewSavedAt;
  }

  getPostGameReviewLastEditedAt() {
    return this.postGameReviewLastEditedAt;
  }

  toJSON() {
    return {
      username: this.username,
      title: this.title,
      fileTimestamp: this.fileTimestamp,
      videoStartTimestamp: this.videoStartTimestamp,
      postGameReview: this.postGameReview,
      postGameReviewSavedAt: this.postGameReviewSavedAt,
      postGameReviewLastEditedAt: this.postGameReviewLastEditedAt,
    };
  }
}

module.exports = SessionMetadata;
