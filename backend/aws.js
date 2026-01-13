const AWS = require('aws-sdk');
require('dotenv').config({ path: __dirname + '/.env' }); // __dirname resolves to backend/
const SessionMetadata = require('./metadata.js')
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

class AWSManager {
  constructor(username) {
    this.username = username;
    this.bucket = process.env.AWS_BUCKET_NAME;
    this.region = process.env.AWS_REGION;
    this.arn = process.env.AWS_ROLE_ARN;
    this.s3 = null; // will be initialized asynchronously
  }

  async init() {
    const sts = new AWS.STS({ region: this.region, accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY });
    const data = await sts.assumeRole({
      RoleArn: this.arn,
      RoleSessionName: `session-${this.username}-${Date.now()}`,
      DurationSeconds: 43200,
    }).promise();

    this.s3 = new AWS.S3({
      region: this.region,
      accessKeyId: data.Credentials.AccessKeyId,
      secretAccessKey: data.Credentials.SecretAccessKey,
      sessionToken: data.Credentials.SessionToken,
      httpOptions: {
        timeout: 2 * 60 * 1000, // 2 minutes
      },
      maxRetries: 3, // optional: retry failed uploads
        });
    console.log("Instantiated S3 client successfully");
    return this; 
  }

  async createFileStructure(username) {
    this.username = username;
    const baseKey = `${username}/`;
    const folders = ['metadata/', 'annotations/', 'videos/'];

    await Promise.all(
      folders.map(async (folder) => {
        try {
          await this.s3
            .putObject({
              Bucket: this.bucket,
              Key: baseKey + folder,
              Body: '',
            })
            .promise();
        } catch (err) {
          // Log and continue if it's an "already exists" type error
          console.warn(`⚠️ Could not create ${baseKey + folder}:`, err.code || err.message);
        }
      })
    );

    console.log(`✅ Ensured S3 folders exist for ${username}`);
  }


    async listFilesFromS3(prefix, extensionFilter = '') {
  try {
    const listedObjects = await this.s3.listObjectsV2({
      Bucket: this.bucket,
      Prefix: prefix,
    }).promise();

    return listedObjects.Contents
      .filter(obj => obj.Key.endsWith(extensionFilter))
      .map(obj => ({
        key: obj.Key,
        lastModified: obj.LastModified,
        size: obj.Size,
      }));
  } catch (err) {
    console.error(`❌ Failed to list files from S3 at prefix ${prefix}`, err);
    return [];
  }
}

  async getFileFromS3(key) {
    try {
      const data = await this.s3.getObject({
        Bucket: this.bucket,
        Key: key,
      }).promise();
      return data.Body;
    } catch (err) {
      console.error(`❌ Failed to get file from S3: ${key}`, err);
      throw err;
    }
  }

    async loadJSON(username, fileTimestamp, folderName) {
        const key = `${username}/${folderName}/${fileTimestamp}.json`;
        const params = {
            Bucket: this.bucket,
            Key: key,
        };

        try {
            const data = await this.s3.getObject(params).promise();
            return JSON.parse(data.Body.toString('utf-8'));
        } catch (err) {
            console.error(`❌ Failed to load ${key}:`, err);
            return null;
        }
    }

    async uploadFile(buffer, username, fileTimestamp, folderName) {
        let key = '';
        if (folderName == 'videos') {
          key = `${username}/${folderName}/${fileTimestamp}.mkv`;
        } else {
          key = `${username}/${folderName}/${fileTimestamp}.json`;
        }
        console.log(`Attempting to upload to s3://${this.bucket}/${key}`);
        const params = {
            Bucket: this.bucket,
            Key: key,
            Body: buffer,
        };

        await this.s3.upload(params).promise();
        console.log(`✅ Uploaded to s3://${this.bucket}/${key}`);
    }

  async loadSessionsFromS3(username) {
    const sessions = [];

    try {
      // 1️⃣ List files
      const videos = await this.listFilesFromS3(`${username}/videos/`, '.mkv');
      const annotations = await this.listFilesFromS3(`${username}/annotations/`, '.json');
      const metadataFiles = await this.listFilesFromS3(`${username}/metadata/`, '.json');

      // Helper: strip extension → get base name
      const getBaseName = (key) => key.split('/').pop().replace(/\.(json|mkv)$/, '');

      // 2️⃣ Index files by base name
      const videoMap = new Map(videos.map(v => [getBaseName(v.key), v.key]));
      const annotationMap = new Map(annotations.map(a => [getBaseName(a.key), a.key]));
      const metadataMap = new Map(metadataFiles.map(m => [getBaseName(m.key), m.key]));

      // 3️⃣ Use metadata as the canonical list of sessions (we can fallback to local videos)
      const validBases = [...metadataMap.keys()];

      // 4️⃣ Sort valid bases by metadata timestamp descending
      const parseTimestampFromFilename = (base) => {
        const [datePart, timePart] = base.split(' ');
        const [year, month, day] = datePart.split('-').map(Number);
        const [hour, minute, second] = timePart.split('-').map(Number);
        return new Date(year, month - 1, day, hour, minute, second).getTime();
      };
      validBases.sort((a, b) => parseTimestampFromFilename(b) - parseTimestampFromFilename(a));

      // 5️⃣ Build sessions
      const debugTable = [];
      for (const base of validBases) {
        try {
          const metadataBuffer = await this.getFileFromS3(metadataMap.get(base));
          const metadataObj = JSON.parse(metadataBuffer.toString('utf8'));

          let videoUrl = null;

          // Try S3 video key first
          if (videoMap.has(base)) {
            videoUrl = await this._safeGetSignedUrl(videoMap.get(base));
            if (!videoUrl) {
              console.warn(`Signed URL generation failed for S3 video key ${videoMap.get(base)}; will try local fallback`);
            }
          }

          // Fallback: search local OBS save path for closest mtime to videoStartTimestamp
          let usedLocalFallback = false;
          if (!videoUrl) {
            usedLocalFallback = true;
            console.log(`No S3 video found for ${base}, attempting local video fallback`);
            // Parse the base filename timestamp first and prefer it when metadata timestamp is missing or clearly different
            const parsedBaseTs = await this.parseTimestampFromFilename(base);
            console.log(`Parsed base timestamp: ${parsedBaseTs} (${new Date(parsedBaseTs).toLocaleString()})`);

            if (!metadataObj.videoStartTimestamp || Math.abs((metadataObj.videoStartTimestamp || 0) - parsedBaseTs) > 5 * 60 * 1000 || Math.abs((metadataObj.videoStartTimestamp || 0) - parsedBaseTs) > 5 * 60 * 1000) {
              console.log(`[loadSessionsFromS3] overriding metadata.videoStartTimestamp (${metadataObj.videoStartTimestamp}) with parsed base timestamp ${parsedBaseTs}`);
              metadataObj.videoStartTimestamp = parsedBaseTs;
            }

            console.log(`Using target timestamp for local search: ${metadataObj.videoStartTimestamp} (${new Date(metadataObj.videoStartTimestamp).toLocaleString()})`);
            const targetTs = metadataObj.videoStartTimestamp;
            // only accept local matches within ±5 minutes
            const FIVE_MIN_MS = 5 * 60 * 1000;
            const local = await this.findLocalVideoClosest(targetTs, FIVE_MIN_MS);
            if (local) {
              console.log(`Using local video fallback for ${base}: ${local}`);
              videoUrl = local; // should be a file:// URL
            }
          }

          // If we attempted local fallback but got nothing, skip this session entirely
          if (usedLocalFallback && !videoUrl) {
            console.log(`Skipping session for ${base} - attempted local fallback but all videos out of range of session`);
            continue;
          }

          const metadataUrl = await this._safeGetSignedUrl(metadataMap.get(base));

          let annotationUrl = null;
          if (annotationMap.has(base)) {
            annotationUrl = await this._safeGetSignedUrl(annotationMap.get(base));
          }

          // Skip if mandatory metadata signed URL failed
          if (!metadataUrl) {
            console.warn(`Skipping session for ${base} because metadata signed URL failed`);
            continue;
          }

          // Skip entirely if no video URL (either S3 or local) could be found
          if (!videoUrl) {
            console.warn(`Skipping session for ${base} - no video URL available (no S3 and no matching local video)`);
            continue;
          }

          // // If still no videoUrl, include session (will show 'No video available' in UI)
          // // If we used a local fallback, prefer the parsed base timestamp as the video's start time
          let sessionVideoStart = metadataObj.videoStartTimestamp || 0;
          if (videoUrl && String(videoUrl).startsWith('file://')) {
            try {
              const parsed = await this.parseTimestampFromFilename(base);
              sessionVideoStart = parsed || sessionVideoStart;
              console.log(`[loadSessionsFromS3] overriding videoStartTimestamp for ${base} with parsed base timestamp: ${sessionVideoStart} (${new Date(sessionVideoStart).toISOString()})`);
            } catch (e) {
              console.warn('[loadSessionsFromS3] failed to parse base timestamp for', base, e && e.message);
            }
          }

          sessions.push({
            title: metadataObj.title || `Session`,
            videoStartTimestamp: sessionVideoStart,
            videoUrl,
            annotationUrl, // null if no annotation
            metadataUrl,
          });

          debugTable.push({
            base,
            hasVideo: !!videoMap.get(base),
            hasMetadata: !!metadataMap.get(base),
            hasAnnotation: !!annotationMap.get(base),
            usedLocal: !!videoUrl && !videoMap.get(base),
          });

        } catch (err) {
          console.warn(`Skipping session for ${base} due to metadata load error`, err);
        }
      }

      console.table(debugTable);

    } catch (err) {
      console.error("Error loading sessions from S3:", err);
    }

    return sessions;
  }


// Helper to work with both AWS SDK v2 & v3
async _safeGetSignedUrl(key) {
  if (!key) return null;
  try {
    if (typeof this.s3.getSignedUrl === 'function') {
      // AWS SDK v2
      return this.s3.getSignedUrl('getObject', {
        Bucket: this.bucket,
        Key: key,
        Expires: 3600,
      });
    } else {
      // AWS SDK v3
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
      return await getSignedUrl(this.s3, new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }), { expiresIn: 3600 });
    }
  } catch (err) {
    console.error(`Error generating signed URL for ${key}:`, err);
    return null;
  }
}


  async findLocalVideoClosest(targetTimestamp, windowMs = 5 * 60 * 1000) {
    console.log("Searching local video files closest to timestamp:", new Date(targetTimestamp).toLocaleString(), `(±${windowMs}ms window)`);
    // Search common OBS/video save locations (allow override via OBS_VIDEO_PATH env)
    const searchDirs = [];
    if (process.env.OBS_VIDEO_PATH) searchDirs.push(process.env.OBS_VIDEO_PATH);
    // Common places
    searchDirs.push(path.join(os.homedir(), 'Videos'));
    searchDirs.push(path.join(os.homedir(), 'Movies'));
    searchDirs.push(path.join(process.cwd(), 'videos'));

    const exts = ['.mkv', '.mp4', '.flv', '.mov'];
    const candidates = [];

    for (const dir of searchDirs) {
      try {
        const files = await fs.promises.readdir(dir);
        console.log(`[findLocalVideoClosest] scanning dir: ${dir} (${files.length} entries)`);
        for (const f of files) {
          const full = path.join(dir, f);
          try {
            const stat = await fs.promises.stat(full);
            if (!stat.isFile()) continue;
            const ext = path.extname(f).toLowerCase();
            if (!exts.includes(ext)) continue;
            const mtime = stat.mtime.getTime();
            // Prefer parsing the timestamp from the filename (YYYY-MM-DD HH-MM-SS) when available
            let fileTs = null;
            let parsedFromFilename = false;
            try {
              fileTs = await this.parseTimestampFromFilename(f);
              parsedFromFilename = true;
            } catch (e) {
              fileTs = mtime;
              console.warn('[findLocalVideoClosest] parseTimestampFromFilename failed for', f, '-', e && e.message);
            }

            const diff = Math.abs(fileTs - targetTimestamp);
            candidates.push({ file: full, fileTsLocal: new Date(fileTs).toLocaleString(), fileTsMs: fileTs, mtimeLocal: new Date(mtime).toLocaleString(), mtimeMs: mtime, diff, parsedFromFilename });
          } catch (e) {
            console.warn('[findLocalVideoClosest] file stat failed:', full, e && e.message);
            continue;
          }
        }
      } catch (e) {
        console.warn('[findLocalVideoClosest] failed to read dir:', dir, e && e.message);
        continue; // ignore dirs that don't exist
      }
    }

    console.log('[findLocalVideoClosest] candidates count:', candidates.length);
    if (candidates.length === 0) {
      console.log('[findLocalVideoClosest] NO LOCAL VIDEOS FOUND');
      return null;
    }

    console.log(`[findLocalVideoClosest] evaluating window ±${windowMs}ms around target ${targetTimestamp} (${new Date(targetTimestamp).toLocaleString()})`);

    // Show a concise summary of each candidate so we can debug why none fall within the window
    console.log('[findLocalVideoClosest] candidate summary (index, file, fileTsMs, fileTsLocal, mtimeMs, mtimeLocal, diff, parsedFromFilename):');
    candidates.forEach((c, i) => {
      console.log(`  ${i}: ${c.file} | fileTsMs=${c.fileTsMs} (${c.fileTsLocal}) | mtimeMs=${c.mtimeMs} (${c.mtimeLocal}) | diff=${c.diff} | absDelta=${Math.abs(c.fileTsMs - targetTimestamp)} | parsedFromFilename=${c.parsedFromFilename}`);
    });

    // Accept videos within ±windowMs of the target timestamp (use parsed filename timestamp)
    const withinWindow = candidates
      .map(c => ({ ...c, absDelta: Math.abs(c.fileTsMs - targetTimestamp) }))
      .filter(c => c.absDelta <= windowMs)
      .sort((a, b) => a.absDelta - b.absDelta);

    if (withinWindow.length > 0) {
      const best = withinWindow[0];
      const target = targetTimestamp;
      const fileTs = best.fileTsMs;
      const delta = fileTs - target;
      console.log('[findLocalVideoClosest] best within-window candidate object:', best);
      console.log(`[findLocalVideoClosest] numeric check -> target: ${target}, fileTs: ${fileTs}, deltaMs: ${delta}, recorded diff: ${best.diff}, parsedFromFilename: ${best.parsedFromFilename}`);
      console.log('[findLocalVideoClosest] selected (within ±window):', pathToFileURL(best.file).href, `(deltaMs=${delta})`);
      return pathToFileURL(best.file).href;
    }

    // No video within ±window; provide the closest candidate info for debugging
    const sortedByDelta = candidates.slice().sort((a, b) => Math.abs(a.fileTsMs - targetTimestamp) - Math.abs(b.fileTsMs - targetTimestamp));
    const closest = sortedByDelta[0];
    if (closest) {
      console.warn('[findLocalVideoClosest] no local video within ±window of target; closest candidate info:');
      console.warn(`  file: ${closest.file}`);
      console.warn(`  fileTsMs: ${closest.fileTsMs} (${closest.fileTsLocal})`);
      console.warn(`  mtimeMs: ${closest.mtimeMs} (${closest.mtimeLocal})`);
      console.warn(`  absDelta: ${Math.abs(closest.fileTsMs - targetTimestamp)} ms`);
      console.warn(`  parsedFromFilename: ${closest.parsedFromFilename}`);
    } else {
      console.warn('[findLocalVideoClosest] no local video within ±window of target; no candidates available to show');
    }
    return null;
    return null;
  }

  async saveMetadata(sessionMetadata) {
    const username = sessionMetadata.getUsername();
    const fileTimestamp = sessionMetadata.getFileTimestamp();
    const key = `${username}/metadata/${fileTimestamp}.json`;

    try {
      try {
        const s3Object = await this.s3.getObject({
          Bucket: this.bucket,
          Key: key,
        }).promise();

        const body = s3Object.Body.toString();
        const sessionInfo = JSON.parse(body);
        console.log('✅ Existing session metadata loaded from S3:', sessionInfo);
      } catch (err) {
        if (err.code === 'NoSuchKey') {
          console.log('🆕 File not found on S3 — preparing to write session metadata.');
        } else {
          throw err;
        }
      }

      const metadataBuffer = Buffer.from(JSON.stringify(sessionMetadata.toJSON()));
      
      await this.s3.upload({
        Bucket: this.bucket,
        Key: key,
        Body: metadataBuffer,
      }).promise();

      console.log(`✅ Session metadata uploaded to s3://${this.bucket}/${key}`);
    } catch (err) {
      console.error('❌ Failed to save session metadata to S3:', err);
    }
  }

  async parseTimestampFromFilename(filename) {
    // Accept filenames like "2025-08-19 22-13-32.json" or "2026-01-12 15-38-28.mp4"
    // Use path functions to strip any extension robustly and validate the parsed date.
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);

    const parts = base.split(' ');
    if (parts.length < 2) {
      throw new Error(`Filename "${filename}" not in expected 'YYYY-MM-DD HH-MM-SS' format`);
    }

    const [datePart, timePart] = parts;
    const datePieces = datePart.split('-').map(Number);
    const timePieces = timePart.split('-').map(Number);

    if (datePieces.length !== 3 || timePieces.length !== 3) {
      throw new Error(`Filename "${filename}" timestamp parts malformed`);
    }

    const [year, month, day] = datePieces;
    const [hour, minute, second] = timePieces;

    const ts = new Date(year, month - 1, day, hour, minute, second).getTime();
    if (Number.isNaN(ts)) {
      throw new Error(`Parsed date is invalid for filename "${filename}"`);
    }

    return ts;
  }

  async deleteSession(videoUrl) {
    try {
      // 1️⃣ Extract S3 key from signed URL
      const url = new URL(videoUrl);
      const videoKey = decodeURIComponent(url.pathname.substring(1)); 
      // e.g. "nisha/videos/2025-09-25 11-27-38.mkv"

      console.log("🗑 Deleting session using video URL key:", videoKey);

      // 2️⃣ Derive username + fileTimestamp from the videoKey
      // Pattern: "<username>/videos/<timestamp>.mkv"
      const parts = videoKey.split('/');
      const filename = parts.pop();  
      const username = parts.shift();  
      // remaining part should be ["videos"]

      const fileTimestamp = filename.replace(/\.[^/.]+$/, ""); // remove extension

      // 3️⃣ Build the three keys to delete
      const keys = [
        videoKey,
        `${username}/metadata/${fileTimestamp}.json`,
        `${username}/annotations/${fileTimestamp}.json`,
      ];

      console.log("🗂 Keys to delete:", keys);

      // 4️⃣ Delete all 3 files safely
      await Promise.all(
        keys.map(async (Key) => {
          try {
            await this.s3.deleteObject({
              Bucket: this.bucket,
              Key
            }).promise();

            console.log(`   ✅ Deleted: ${Key}`);
          } catch (err) {
            if (err.code === "NoSuchKey") {
              console.warn(`   ⚠️ Missing (already gone): ${Key}`);
            } else {
              console.error(`   ❌ Error deleting ${Key}:`, err);
            }
          }
        })
      );

      console.log("✨ Finished deleting session.");
      return true;

    } catch (err) {
      console.error("❌ deleteSession failed:", err);
      return false;
    }
  }


  async deleteAnnotation(annotationUrl, targetTimestamp) {
    // Parse S3 key from the signed URL
    const url = new URL(annotationUrl);
    const Key = decodeURIComponent(url.pathname.substring(1)); // remove leading /

    // 1. Download the JSON
    const data = await this.s3.getObject({
      Bucket: this.bucket,
      Key
    }).promise();

    let annotations = JSON.parse(data.Body.toString());

    let oldLength = annotations.length;

    // 2. Filter out the entry with that timestamp (or id if you add one)
    annotations = annotations.filter(a => a.timestamp !== targetTimestamp);

    if (annotations.length == oldLength) {
      // Failed to delete something!?
      throw `Didn't find annotation at timestamp ${targetTimestamp}`;
    }

    // 3. Re-upload JSON
    await this.s3.putObject({
      Bucket: this.bucket,
      Key,
      Body: JSON.stringify(annotations, null, 2),
      ContentType: "application/json"
    }).promise();
  }

  async saveAnnotationToS3(sessionMetadata, annotation) {
    try {
        // Step 1: Try to fetch existing file from S3
        let annotations = [];
        let username = sessionMetadata.getUsername();
        let timestamp = sessionMetadata.getFileTimestamp();
        try {
        // maybe get all objects for debugging
        const s3Object = await this.s3.getObject({
            Bucket: this.bucket,
            Key: `${username}/annotations/${timestamp}.json`,
        }).promise();
        console.log(`Trying to save annotation to s3://${s3Object.Bucket}/${s3Object.Key}`);

        const body = s3Object.Body.toString();
        annotations =  JSON.parse(body);
        } catch (err) {
        if (err.code === 'NoSuchKey') {
            console.log('File not found on S3 — starting fresh.');
        } else {
            throw err;
        }
        }

        // Step 2: Add the new annotation
        annotations.push(annotation);

        // Step 3: Convert to buffer
        const buffer = Buffer.from(JSON.stringify(annotations, null, 2));

        // Step 4: Upload to S3
        await this.uploadFile(buffer, username, timestamp, 'annotations');
        console.log('✅ Annotation saved to S3');
    } catch (err) {
        console.error('❌ Error saving annotation to S3:', err);
    }
    }
}

module.exports = AWSManager;
