const { google } = require('googleapis');
const { Storage } = require('@google-cloud/storage');
const path = require('path');

const storage = new Storage();
const drive = google.drive({ version: 'v3' });

// Environment Variables
const FOLDER_ID = process.env.FOLDER_ID;
const DEST_BUCKET_NAME = process.env.DEST_BUCKET;
const STATE_FILE_NAME = 'drive-poller-state.json';

/**
 * Cloud Function entry point.
 * Triggered by Cloud Scheduler (HTTP).
 */
exports.pollDrive = async (req, res) => {
    try {
        console.log(`Starting poll for folder: ${FOLDER_ID}`);

        if (!FOLDER_ID || !DEST_BUCKET_NAME) {
            throw new Error('Missing FOLDER_ID or DEST_BUCKET env vars');
        }

        // 1. Get Auth (ADC works automatically in Cloud Functions if SA has permissions)
        const auth = new google.auth.GoogleAuth({
            scopes: ['https://www.googleapis.com/auth/drive.readonly']
        });
        const authClient = await auth.getClient();
        google.options({ auth: authClient });

        // 2. Load State (Last checked time)
        const lastTime = await getLastCheckTime(DEST_BUCKET_NAME);
        console.log(`Polling for files created after: ${lastTime}`);

        // 3. List Files in Drive
        // Query: Inside folder AND created > lastTime AND not a folder itself
        const q = `'${FOLDER_ID}' in parents and createdTime > '${lastTime}' and mimeType contains 'video/' and trashed = false`;

        const listRes = await drive.files.list({
            q: q,
            fields: 'files(id, name, createdTime, mimeType)',
            orderBy: 'createdTime asc' // Oldest first, to keep order
        });

        const files = listRes.data.files;
        console.log(`Found ${files.length} new files.`);

        if (files.length === 0) {
            res.status(200).send('No new files.');
            return;
        }

        // 4. Process new files
        let newestTime = lastTime;

        for (const file of files) {
            console.log(`Processing file: ${file.name} (${file.id})`);

            await downloadAndUpload(file.id, file.name, DEST_BUCKET_NAME);

            // Update newest time seen
            if (new Date(file.createdTime) > new Date(newestTime)) {
                newestTime = file.createdTime;
            }
        }

        // 5. Save State
        await saveLastCheckTime(DEST_BUCKET_NAME, newestTime);

        res.status(200).send(`Processed ${files.length} files.`);

    } catch (err) {
        console.error('Error in pollDrive:', err);
        res.status(500).send(err.message);
    }
};

/**
 * Reads the state file from GCS to get the last checked timestamp.
 * Defaults to 1 hour ago if no state exists.
 */
async function getLastCheckTime(bucketName) {
    const file = storage.bucket(bucketName).file(STATE_FILE_NAME);
    try {
        const [exists] = await file.exists();
        if (!exists) {
            // Default to 1 hour ago (ISO String)
            const d = new Date();
            d.setHours(d.getHours() - 1);
            return d.toISOString();
        }
        const [content] = await file.download();
        const state = JSON.parse(content.toString());
        return state.lastTime;
    } catch (e) {
        console.warn('Failed to read state, defaulting to 1 hour ago.', e);
        const d = new Date();
        d.setHours(d.getHours() - 1);
        return d.toISOString();
    }
}

/**
 * Saves the new timestamp to GCS.
 */
async function saveLastCheckTime(bucketName, timeStr) {
    const file = storage.bucket(bucketName).file(STATE_FILE_NAME);
    await file.save(JSON.stringify({ lastTime: timeStr }));
    console.log('State updated:', timeStr);
}

/**
 * Streams file from Drive -> GCS
 */
async function downloadAndUpload(fileId, fileName, bucketName) {
    // We need to match the destination bucket object
    const destFile = storage.bucket(bucketName).file(fileName);

    return new Promise(async (resolve, reject) => {
        try {
            const driveRes = await drive.files.get(
                { fileId: fileId, alt: 'media' },
                { responseType: 'stream' }
            );

            driveRes.data
                .on('end', () => resolve())
                .on('error', err => reject(err))
                .pipe(destFile.createWriteStream({
                    metadata: {
                        metadata: {
                            originalDriveId: fileId // Store metadata for tracing
                        }
                    }
                }));

        } catch (e) {
            reject(e);
        }
    });
}
