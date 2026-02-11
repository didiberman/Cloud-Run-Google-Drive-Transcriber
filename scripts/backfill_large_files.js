const { google } = require('googleapis');
const { Storage } = require('@google-cloud/storage');

// CONFIGURATION
const PROJECT_ID = 'sam-drive-automation';
const REGION = 'us-central1';
const FOLDER_ID = '1SD4_7768gW5fG8QcaPo1qKdgQqZvJItx'; // From terraform.tfvars
const DEST_BUCKET = 'sam-drive-automation-audio-input-68a0f741'; // From infra state
const JOB_NAME = `projects/${PROJECT_ID}/locations/${REGION}/jobs/drive-large-downloader`;
const HOURS_LOOKBACK = 48;

const drive = google.drive({ version: 'v3' });
const run = google.run({ version: 'v2' });

async function main() {
    console.log('Starting Backfill for Large Files...');

    // 1. Auth
    const auth = new google.auth.GoogleAuth({
        scopes: [
            'https://www.googleapis.com/auth/cloud-platform',
            'https://www.googleapis.com/auth/drive.readonly'
        ]
    });
    const authClient = await auth.getClient();
    google.options({ auth: authClient });

    // 2. Calculate time range
    const startTime = new Date();
    startTime.setHours(startTime.getHours() - HOURS_LOOKBACK);
    const timeStr = startTime.toISOString();
    console.log(`Looking for files created after: ${timeStr}`);

    // 3. List files
    // Use recursive folder search logic if needed, but for now flat search in specific folder logic is tricky without recursion.
    // I'll stick to a simple recursive search if I can import it, otherwise just list ALL changes?
    // Actually, let's just use the `drive-poller` logic simplified:
    // We assume files are in the folder or subfolders.
    // For simplicity in a script, I'll list files recursively using `q`.

    // First get all folder IDs (recurisvely)
    const allFolderIds = await getAllFolderIds(FOLDER_ID);
    console.log(`Scanning ${allFolderIds.length} folders...`);

    const parentQueries = allFolderIds.map(id => `'${id}' in parents`).join(' or ');
    const q = `(${parentQueries}) and createdTime > '${timeStr}' and mimeType contains 'video/' and trashed = false`;

    let files = [];
    let pageToken = null;

    do {
        const res = await drive.files.list({
            q,
            fields: 'nextPageToken, files(id, name, createdTime, mimeType, size, parents)',
            pageToken
        });
        files = files.concat(res.data.files);
        pageToken = res.data.nextPageToken;
    } while (pageToken);

    console.log(`Found ${files.length} videos in total.`);

    // 4. Filter and Trigger
    let triggeredCount = 0;
    for (const file of files) {
        const sizeGB = (parseInt(file.size) / (1024 * 1024 * 1024)).toFixed(2);
        console.log(`Checking ${file.name} (${sizeGB} GB)...`);

        // Check if > 1GB
        if (parseInt(file.size) > 1024 * 1024 * 1024) {
            console.log(`>>> Triggering Job for ${file.name} (${file.id})`);

            const parentFolderId = file.parents && file.parents.length > 0 ? file.parents[0] : '';
            await triggerJob(file.id, file.name, DEST_BUCKET, parentFolderId);
            triggeredCount++;
        } else {
            console.log(`   Skipping (small file)`);
        }
    }

    console.log(`\nDone! Triggered ${triggeredCount} jobs.`);
}

async function triggerJob(fileId, fileName, destBucket, parentFolderId) {
    const request = {
        name: JOB_NAME,
        overrides: {
            containerOverrides: [{
                env: [
                    { name: 'FILE_ID', value: fileId },
                    { name: 'FILE_NAME', value: fileName },
                    { name: 'DEST_BUCKET', value: destBucket },
                    { name: 'PARENT_FOLDER_ID', value: parentFolderId }
                ]
            }]
        }
    };
    await run.projects.locations.jobs.run(request);
}

// Reuse helper
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
            await getSubfolders(folder.id);
        }
    }
    await getSubfolders(parentFolderId);
    return allIds;
}

main().catch(console.error);
