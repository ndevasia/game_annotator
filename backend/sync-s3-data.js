/**
 * Utility script to sync participant data from S3 to local s3_data folder
 * Run with: node sync-s3-data.js
 */

const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: __dirname + '/.env' });

const S3_DATA_DIR = path.join(__dirname, '..', 's3_data');

class S3DataSyncer {
  constructor() {
    this.bucket = process.env.AWS_BUCKET_NAME;
    this.region = process.env.AWS_REGION;
    this.arn = process.env.AWS_ROLE_ARN;
    this.s3 = null;
  }

  async init() {
    try {
      const sts = new AWS.STS({
        region: this.region,
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      });

      const data = await sts.assumeRole({
        RoleArn: this.arn,
        RoleSessionName: `sync-${Date.now()}`,
        DurationSeconds: 43200,
      }).promise();

      this.s3 = new AWS.S3({
        region: this.region,
        accessKeyId: data.Credentials.AccessKeyId,
        secretAccessKey: data.Credentials.SecretAccessKey,
        sessionToken: data.Credentials.SessionToken,
        httpOptions: { timeout: 2 * 60 * 1000 },
        maxRetries: 3,
      });

      console.log('✅ S3 client initialized');
      return true;
    } catch (err) {
      console.error('❌ Failed to initialize S3:', err.message);
      return false;
    }
  }

  async listParticipants() {
    try {
      const result = await this.s3.listObjectsV2({
        Bucket: this.bucket,
        Delimiter: '/',
      }).promise();

      const participants = result.CommonPrefixes
        .map(p => p.Prefix.replace(/\/$/, ''))
        .filter(name => name.startsWith('participant_'))
        .sort();

      console.log(`📋 Found ${participants.length} participants:`, participants);
      return participants;
    } catch (err) {
      console.error('❌ Failed to list participants:', err.message);
      return [];
    }
  }

  async downloadParticipantData(username) {
    console.log(`\n📥 Downloading data for ${username}...`);

    const userDir = path.join(S3_DATA_DIR, username);
    const folders = ['metadata', 'annotations', 'videos'];

    // Ensure directories exist
    for (const folder of folders) {
      const folderPath = path.join(userDir, folder);
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }
    }

    let totalFiles = 0;
    for (const folder of folders) {
      const prefix = `${username}/${folder}/`;
      console.log(`  📂 Syncing ${folder}...`);

      try {
        let continuationToken = null;
        let hasMore = true;

        while (hasMore) {
          const params = {
            Bucket: this.bucket,
            Prefix: prefix,
          };

          if (continuationToken) {
            params.ContinuationToken = continuationToken;
          }

          const result = await this.s3.listObjectsV2(params).promise();

          if (result.Contents) {
            for (const obj of result.Contents) {
              // Skip folder markers
              if (obj.Key.endsWith('/')) continue;

              const fileName = path.basename(obj.Key);
              const filePath = path.join(userDir, folder, fileName);

              // Download file
              try {
                const data = await this.s3.getObject({
                  Bucket: this.bucket,
                  Key: obj.Key,
                }).promise();

                fs.writeFileSync(filePath, data.Body);
                totalFiles++;
                process.stdout.write(`\r  ✓ Downloaded ${totalFiles} files...`);
              } catch (err) {
                console.error(`\n  ❌ Error downloading ${obj.Key}:`, err.message);
              }
            }
          }

          hasMore = result.IsTruncated;
          continuationToken = result.NextContinuationToken;
        }

        console.log(`\n  ✅ Synced ${folder}`);
      } catch (err) {
        console.error(`  ❌ Error syncing ${folder}:`, err.message);
      }
    }

    return totalFiles;
  }

  async syncAll() {
    console.log('🔄 Starting S3 data sync...\n');

    if (!fs.existsSync(S3_DATA_DIR)) {
      fs.mkdirSync(S3_DATA_DIR, { recursive: true });
      console.log(`📁 Created s3_data directory\n`);
    }

    const participants = await this.listParticipants();
    if (participants.length === 0) {
      console.log('⚠️ No participants found');
      return;
    }

    let totalDownloaded = 0;
    for (const participant of participants) {
      const count = await this.downloadParticipantData(participant);
      totalDownloaded += count;
    }

    console.log(`\n✅ Sync complete! Downloaded ${totalDownloaded} total files`);
  }
}

// Run sync
const syncer = new S3DataSyncer();
syncer.init().then(success => {
  if (success) {
    syncer.syncAll().catch(err => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
  } else {
    process.exit(1);
  }
});
