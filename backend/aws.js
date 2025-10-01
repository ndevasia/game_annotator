const AWS = require('aws-sdk');
require('dotenv').config({ path: __dirname + '/.env' }); // __dirname resolves to backend/
const SessionMetadata = require('./metadata.js')

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

      // 3️⃣ Handle orphaned annotations
      // for (const [base, annotationKey] of annotationMap.entries()) {
      //   if (!videoMap.has(base) || !metadataMap.has(base)) {
      //     console.log(`🗑️ Deleting orphaned annotation: ${annotationKey}`);
      //     await this.s3.deleteObject({ Bucket: this.bucket, Key: annotationKey }).promise();
      //     annotationMap.delete(base);
      //   }
      // }

      // 4️⃣ Combine all bases that have at least video + metadata
      const validBases = [...videoMap.keys()].filter(base => metadataMap.has(base));

      // 5️⃣ Sort valid bases by metadata timestamp descending
      const parseTimestampFromFilename = (base) => {
        const [datePart, timePart] = base.split(' ');
        const [year, month, day] = datePart.split('-').map(Number);
        const [hour, minute, second] = timePart.split('-').map(Number);
        return new Date(year, month - 1, day, hour, minute, second).getTime();
      };
      validBases.sort((a, b) => parseTimestampFromFilename(b) - parseTimestampFromFilename(a));

      // 6️⃣ Build sessions
      const debugTable = [];
      for (const base of validBases) {
        try {
          const metadataBuffer = await this.getFileFromS3(metadataMap.get(base));
          const metadataObj = JSON.parse(metadataBuffer.toString('utf8'));

          const videoUrl = await this._safeGetSignedUrl(videoMap.get(base));
          const metadataUrl = await this._safeGetSignedUrl(metadataMap.get(base));

          let annotationUrl = null;
          if (annotationMap.has(base)) {
            annotationUrl = await this._safeGetSignedUrl(annotationMap.get(base));
          }

          // Skip if mandatory signed URLs failed
          if (!videoUrl || !metadataUrl) {
            console.warn(`Skipping session for ${base} due to signed URL error`);
            continue;
          }

          sessions.push({
            title: metadataObj.title || `Session`,
            videoStartTimestamp: metadataObj.videoStartTimestamp || 0,
            videoUrl,
            annotationUrl, // null if no annotation
            metadataUrl,
          });

          debugTable.push({
            base,
            hasVideo: !!videoMap.get(base),
            hasMetadata: !!metadataMap.get(base),
            hasAnnotation: !!annotationMap.get(base),
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
    // filename like "2025-08-19 22-13-32.json"
    const base = filename.replace(/\.(json|mkv)$/, '');
    const [datePart, timePart] = base.split(' ');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute, second] = timePart.split('-').map(Number);
    return new Date(year, month - 1, day, hour, minute, second).getTime();
  }

  async deleteSession(username, fileTimestamp) {
  const keys = [
    `${username}/videos/${fileTimestamp}.mkv`,
    `${username}/metadata/${fileTimestamp}.json`,
    `${username}/annotations/${fileTimestamp}.json`,
  ];

  try {
    console.log(`🗑 Deleting session ${fileTimestamp} for user ${username}...`);

    // Try deleting all three, ignoring missing files
    await Promise.all(keys.map(async (Key) => {
      try {
        await this.s3.deleteObject({ Bucket: this.bucket, Key }).promise();
        console.log(`✅ Deleted s3://${this.bucket}/${Key}`);
      } catch (err) {
        if (err.code === "NoSuchKey") {
          console.warn(`⚠️ File not found: ${Key}`);
        } else {
          console.error(`❌ Failed to delete ${Key}:`, err);
        }
      }
    }));

    console.log(`✨ Finished deleting session ${fileTimestamp}`);
    return true;
  } catch (err) {
    console.error(`❌ Error deleting session ${fileTimestamp}:`, err);
    return false;
  }
}


  async deleteAnnotation(username, annotationUrl, targetTimestamp) {
    // Parse S3 key from the signed URL
    const url = new URL(annotationUrl);
    const Key = decodeURIComponent(url.pathname.substring(1)); // remove leading /

    // 1. Download the JSON
    const data = await this.s3.getObject({
      Bucket: this.bucket,
      Key
    }).promise();

    let annotations = JSON.parse(data.Body.toString());

    // 2. Filter out the entry with that timestamp (or id if you add one)
    annotations = annotations.filter(a => a.timestamp !== targetTimestamp);

    // 3. Re-upload JSON
    await this.s3.putObject({
      Bucket: this.bucket,
      Key,
      Body: JSON.stringify(annotations, null, 2),
      ContentType: "application/json"
    }).promise();

    return true;
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
