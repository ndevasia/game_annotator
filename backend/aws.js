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

//   async getAnnotationFromS3(username) {
//     // Step 1: Try to fetch existing file from S3
//         let annotations = [];

//         try {
//         const s3Object = await this.s3.getObject({
//             Bucket: this.bucket,
//             Key: `${username}/${folderName}/${fileName}`,
//         }).promise();

//         const body = s3Object.Body.toString();
//         annotations = JSON.parse(body);
//         } catch (err) {
//         if (err.code === 'NoSuchKey') {
//             console.log('File not found on S3 — starting fresh.');
//         } else {
//             throw err;
//         }
//         }
//   }

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
        const key = `${username}/${folderName}/${fileTimestamp}.json`;
        console.log(`Attempting to upload to s3://${this.bucket}/${key}`);
        const params = {
            Bucket: this.bucket,
            Key: key,
            Body: buffer,
        };

        await this.s3.upload(params).promise();
        console.log(`✅ Uploaded to s3://${this.bucket}/${key}`);
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
