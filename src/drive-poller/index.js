const { google } = require('googleapis');
const { Storage } = require('@google-cloud/storage');
const path = require('path');

const storage = new Storage();
const drive = google.drive({ version: 'v3' });
const run = google.run({ version: 'v2' });

// Environment Variables
const FOLDER_ID = process.env.FOLDER_ID;
const DEST_BUCKET_NAME = process.env.DEST_BUCKET;
const STATE_FILE_NAME = 'drive-poller-state.json';
const MAX_VIDEO_DURATION_MS = 3 * 60 * 60 * 1000; // 3 hours (Video Intelligence API max)
const LARGE_FILE_THRESHOLD_BYTES = 1024 * 1024 * 1024; // 1 GB
const LARGE_DOWNLOAD_JOB_NAME = process.env.LARGE_DOWNLOAD_JOB_NAME; // e.g. "projects/.../locations/.../jobs/drive-large-downloader"

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
            scopes: [
                'https://www.googleapis.com/auth/cloud-platform',
                'https://www.googleapis.com/auth/drive.readonly'
            ]
        });
        const authClient = await auth.getClient();
        google.options({ auth: authClient });

        // 2. Load State (Last checked time)
        let lastTime;
        if (req.query && req.query.backfill === 'true') {
            const hours = parseInt(req.query.hours) || 48; // Default 48h
            const d = new Date();
            d.setHours(d.getHours() - hours);
            lastTime = d.toISOString();
            console.log(`[BACKFILL MODE] Polling for files created after: ${lastTime} (${hours} hours ago)`);
        } else {
            lastTime = await getLastCheckTime(DEST_BUCKET_NAME);
            console.log(`Polling for files created after: ${lastTime}`);
        }

        // 3. Get all folder IDs (parent + subfolders)
        const allFolderIds = await getAllFolderIds(FOLDER_ID);
        console.log(`Monitoring ${allFolderIds.length} folders (including subfolders)`);

        // 4. List Files in Drive from all folders
        // Build query: (folder1 in parents OR folder2 in parents OR ...) AND video AND created > lastTime
        const parentQueries = allFolderIds.map(id => `'${id}' in parents`).join(' or ');
        const q = `(${parentQueries}) and createdTime > '${lastTime}' and mimeType contains 'video/' and trashed = false`;

        const listRes = await drive.files.list({
            q: q,
            fields: 'files(id, name, createdTime, mimeType, videoMediaMetadata, parents, size)',
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
        let processedCount = 0;
        let triggeredJobsCount = 0;

        for (const file of files) {
            // Check video duration (skip if over 3 hours)
            const durationMs = file.videoMediaMetadata?.durationMillis;
            if (durationMs && parseInt(durationMs) > MAX_VIDEO_DURATION_MS) {
                const durationHours = (parseInt(durationMs) / 3600000).toFixed(1);
                console.log(`Skipping file "${file.name}" - duration ${durationHours}h exceeds 3h limit`);
                // Still update newest time so we don't reprocess this file
                if (new Date(file.createdTime) > new Date(newestTime)) {
                    newestTime = file.createdTime;
                }
                continue;
            }

            console.log(`Processing file: ${file.name} (${file.id}) - Size: ${file.size} bytes`);

            // Get parent folder ID for later Drive upload
            const parentFolderId = file.parents && file.parents.length > 0 ? file.parents[0] : null;

            // Check if file is large (>1GB) -> Trigger Cloud Run Job
            if (parseInt(file.size) > LARGE_FILE_THRESHOLD_BYTES && LARGE_DOWNLOAD_JOB_NAME) {
                console.log(`File is large (>1GB). Triggering Cloud Run Job...`);
                await triggerLargeDownloadJob(file.id, file.name, DEST_BUCKET_NAME, parentFolderId);
                triggeredJobsCount++;
            } else {
                console.log(`File is small (<=1GB). Downloading inline...`);
                await downloadAndUpload(file.id, file.name, DEST_BUCKET_NAME, parentFolderId);
            }
            processedCount++;

            // Update newest time seen
            if (new Date(file.createdTime) > new Date(newestTime)) {
                newestTime = file.createdTime;
            }
        }

        // 5. Save State
        await saveLastCheckTime(DEST_BUCKET_NAME, newestTime);

        const skippedCount = files.length - processedCount;
        res.status(200).send(`Processed ${processedCount} files (${triggeredJobsCount} via Job)${skippedCount > 0 ? `, skipped ${skippedCount}` : ''}.`);

    } catch (err) {
        console.error('Error in pollDrive:', err);
        res.status(500).send(err.message);
    }
};

/**
 * Triggers the Cloud Run Job for large file download.
 * Uses the googleapis Node.js client to call Cloud Run v2 jobs.run().
 * IMPORTANT: `overrides` must be in `requestBody` (not top-level),
 * because the googleapis client sends top-level properties as query params.
 */
async function triggerLargeDownloadJob(fileId, fileName, destBucket, parentFolderId) {
    const request = {
        // Path parameter: the full resource name of the job
        name: LARGE_DOWNLOAD_JOB_NAME,
        // Body payload: overrides for the job execution
        requestBody: {
            overrides: {
                containerOverrides: [
                    {
                        env: [
                            { name: 'FILE_ID', value: fileId },
                            { name: 'FILE_NAME', value: fileName },
                            { name: 'DEST_BUCKET', value: destBucket },
                            { name: 'PARENT_FOLDER_ID', value: parentFolderId || '' }
                        ]
                    }
                ]
            }
        }
    };

    try {
        console.log(`Triggering Cloud Run Job: ${LARGE_DOWNLOAD_JOB_NAME}`);
        console.log(`  File: ${fileName} (${fileId}), Bucket: ${destBucket}`);
        const response = await run.projects.locations.jobs.run(request);
        console.log(`Job triggered successfully. Operation: ${response.data.name}`);
    } catch (e) {
        console.error('Failed to trigger Cloud Run Job:', e.message || e);
        throw e;
    }
}

/**
 * Recursively gets all folder IDs (parent + all subfolders).
 * @param {string} parentFolderId - The root folder ID
 * @returns {Promise<string[]>} Array of all folder IDs
 */
async function getAllFolderIds(parentFolderId) {
    const allIds = [parentFolderId];

    async function getSubfolders(folderId) {
        const res = await drive.files.list({
            q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            fields: 'files(id, name)',
        });

        const subfolders = res.data.files || [];
        for (const folder of subfolders) {
            allIds.push(folder.id);
            // Recursively get subfolders
            await getSubfolders(folder.id);
        }
    }

    await getSubfolders(parentFolderId);
    return allIds;
}

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
async function downloadAndUpload(fileId, fileName, bucketName, parentFolderId) {
    // We need to match the destination bucket object
    const destFile = storage.bucket(bucketName).file(fileName);

    return new Promise(async (resolve, reject) => {
        try {
            const driveRes = await drive.files.get(
                { fileId: fileId, alt: 'media' },
                { responseType: 'stream' }
            );

            const writeStream = destFile.createWriteStream({
                metadata: {
                    metadata: {
                        originalDriveId: fileId,
                        parentFolderId: parentFolderId || ''
                    }
                }
            });

            driveRes.data
                .on('error', err => reject(err))
                .pipe(writeStream)
                .on('finish', () => resolve()) // Resolve when GCS upload is complete
                .on('error', err => reject(err));

        } catch (e) {
            reject(e);
        }
    });
}
