const AWS = require('aws-sdk');
require('dotenv').config({ path: __dirname + '/.env' }); // __dirname resolves to backend/
const SessionMetadata = require('./metadata.js')

class AWSManager {
  constructor() {
    const bucket = process.env.AWS_BUCKET_NAME
    const region = process.env.AWS_REGION
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
    this.bucket = bucket;
    this.s3 = new AWS.S3({
      region: region,
      accessKeyId: accessKeyId,
      secretAccessKey: secretAccessKey
    });
  }

  async getClient() {
    return this.s3;
  }

  async createFileStructure(username) {
    this.username = username;
    const baseKey = `${username}/`;
    const folders = ['metadata/', 'annotations/', 'videos/'];

    try {
      await Promise.all(
        folders.map((folder) =>
          this.s3
            .putObject({
              Bucket: this.bucket,
              Key: baseKey + folder,
              Body: '',
            })
            .promise()
        )
      );
      console.log(`✅ Created S3 folders for ${username}`);
    } catch (err) {
      console.error(`❌ Error creating S3 folders for ${username}:`, err);
    }
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

  async getSignedUrl(key, expiresInSeconds = 3600) {
    try {
      const url = await this.s3.getSignedUrlPromise('getObject', {
        Bucket: this.bucket,
        Key: key,
        Expires: expiresInSeconds,
      });
      return url;
    } catch (err) {
      console.error(`❌ Failed to generate signed URL for ${key}`, err);
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
  // Always return an array, even if empty
  const sessions = [];

  try {
    // 1️⃣ List files
    const videos = await this.listFilesFromS3(`${username}/videos/`, '.mkv');
    const annotations = await this.listFilesFromS3(`${username}/annotations/`, '.json');
    const metadataFiles = await this.listFilesFromS3(`${username}/metadata/`, '.json');

    // Sort by lastModified so indexes match
    videos.sort((a, b) => a.lastModified - b.lastModified);
    annotations.sort((a, b) => a.lastModified - b.lastModified);
    metadataFiles.sort((a, b) => a.lastModified - b.lastModified);

    const numSessions = Math.min(videos.length, annotations.length, metadataFiles.length);

    for (let i = 0; i < numSessions; i++) {
      let metadataObj;
      try {
        const metadataBuffer = await this.getFileFromS3(metadataFiles[i].key);
        metadataObj = JSON.parse(metadataBuffer.toString('utf8'));
      } catch (err) {
        console.warn(`Skipping session due to metadata load error: ${metadataFiles[i].key}`, err);
        continue;
      }

      // 2️⃣ Generate signed URLs safely
      const videoUrl = await this._safeGetSignedUrl(videos[i].key);
      const annotationUrl = await this._safeGetSignedUrl(annotations[i].key);
      const metadataUrl = await this._safeGetSignedUrl(metadataFiles[i].key);

      if (!videoUrl || !annotationUrl || !metadataUrl) {
        console.warn(`Skipping session due to signed URL error`);
        continue;
      }

      // 3️⃣ Push session info
      sessions.push({
        title: metadataObj.title || `Session ${i + 1}`,
        videoStartTimestamp: metadataObj.videoStartTimestamp || 0,
        videoUrl,
        annotationUrl,
        metadataUrl,
      });
    }

    // Sort newest first
    sessions.sort((a, b) => b.videoStartTimestamp - a.videoStartTimestamp);

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

  async  saveAnnotationToS3(username, annotation, fileTimestamp) {
    try {
        // Step 1: Try to fetch existing file from S3
        let annotations = [];
        try {
        // maybe get all objects for debugging
        const s3Object = await this.s3.getObject({
            Bucket: this.bucket,
            Key: `${username}/annotations/${fileTimestamp}.json`,
        }).promise();
        console.log(`Trying to save annotation to s3://${s3Object.Bucket}/${s3Object.Key}`);

        const body = s3Object.Body.toString();
        annotations = JSON.parse(body);
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
        await this.uploadFile(buffer, username, fileTimestamp, 'annotations');
        console.log('✅ Annotation saved to S3');
    } catch (err) {
        console.error('❌ Error saving annotation to S3:', err);
    }
    }


}

module.exports = AWSManager;
