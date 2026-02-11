const { google } = require('googleapis');
const { Storage } = require('@google-cloud/storage');
const path = require('path');

const storage = new Storage();
const drive = google.drive({ version: 'v3' });

/**
 * Cloud Run Job entry point.
 * Reads configuration from Environment Variables.
 */
async function main() {
    console.log('Starting Large File Downloader Job...');

    // 1. Validate Env Vars
    const fileId = process.env.FILE_ID;
    const fileName = process.env.FILE_NAME;
    const destBucket = process.env.DEST_BUCKET;
    const parentFolderId = process.env.PARENT_FOLDER_ID; // Optional, for metadata

    if (!fileId || !fileName || !destBucket) {
        console.error('Missing required env vars: FILE_ID, FILE_NAME, or DEST_BUCKET');
        process.exit(1);
    }

    console.log(`Config:
      File ID: ${fileId}
      File Name: ${fileName}
      Destination: gs://${destBucket}/${fileName}
    `);

    try {
        // 2. Authenticate Drive
        const auth = new google.auth.GoogleAuth({
            scopes: ['https://www.googleapis.com/auth/drive.readonly']
        });
        const authClient = await auth.getClient();
        google.options({ auth: authClient });

        // 3. Setup GCS Upload Stream
        const bucket = storage.bucket(destBucket);
        const file = bucket.file(fileName);

        // Passthrough stream from Drive -> GCS
        // GCS Node SDK automatically handles resumable uploads for large files
        const writeStream = file.createWriteStream({
            metadata: {
                metadata: {
                    originalDriveId: fileId,
                    parentFolderId: parentFolderId || '',
                    processedBy: 'large-downloader-job'
                }
            },
            resumable: true,
            validation: false // Disable MD5 validation for speed on large files
        });

        console.log('Initiating download stream...');

        const res = await drive.files.get(
            { fileId: fileId, alt: 'media' },
            { responseType: 'stream' }
        );

        await new Promise((resolve, reject) => {
            res.data
                .on('end', () => {
                    console.log('Download from Drive completed. Waiting for GCS upload to finish...');
                })
                .on('error', (err) => {
                    console.error('Error in download stream:', err);
                    reject(err);
                })
                .pipe(writeStream)
                .on('error', (err) => {
                    console.error('Error in upload stream:', err);
                    reject(err);
                })
                .on('finish', () => {
                    console.log('Upload to GCS finished successfully.');
                    resolve(); // Resolve only when GCS upload is fully complete
                });
        });

        console.log('Job finished successfully.');
        process.exit(0);

    } catch (err) {
        console.error('Job failed:', err);
        process.exit(1);
    }
}

main();
