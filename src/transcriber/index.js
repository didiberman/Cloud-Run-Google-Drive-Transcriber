const { VideoIntelligenceServiceClient } = require('@google-cloud/video-intelligence');
const { Storage } = require('@google-cloud/storage');
const functions = require('@google-cloud/functions-framework');

const client = new VideoIntelligenceServiceClient();
const storage = new Storage();
const TRANSCRIPT_BUCKET = process.env.TRANSCRIPT_BUCKET;

// File extensions to process (video files only)
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.wmv', '.flv'];

functions.cloudEvent('transcribeAudio', async (cloudEvent) => {
    const file = cloudEvent.data;

    console.log(`Received file: ${file.name} in bucket ${file.bucket}`);

    if (!file.name || !file.bucket) {
        console.error('Invalid cloud event data (missing name or bucket).');
        return;
    }

    // Skip non-video files (e.g., drive-poller-state.json)
    const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
    if (!VIDEO_EXTENSIONS.includes(ext)) {
        console.log(`Skipping non-video file: ${file.name}`);
        return;
    }

    // Idempotency check: Skip if already processed
    const sourceFile = storage.bucket(file.bucket).file(file.name);
    const [metadata] = await sourceFile.getMetadata();
    if (metadata.metadata && metadata.metadata.transcriptionStarted) {
        console.log(`Skipping already-processed file: ${file.name}`);
        return;
    }

    const gcsUri = `gs://${file.bucket}/${file.name}`;
    const outputUri = `gs://${TRANSCRIPT_BUCKET}/${file.name}.json`;

    const request = {
        inputUri: gcsUri,
        outputUri: outputUri,
        features: ['SPEECH_TRANSCRIPTION'],
        videoContext: {
            speechTranscriptionConfig: {
                languageCode: 'en-US',
                enableAutomaticPunctuation: true,
            },
        },
    };

    try {
        console.log(`Starting Video Intelligence job for ${gcsUri}...`);

        // Start the long-running operation FIRST
        // The API will perform the analysis and write the JSON directly to 'outputUri'.
        const [operation] = await client.annotateVideo(request);

        console.log(`Job started. Operation name: ${operation.name}`);
        console.log(`Output will be written to: ${outputUri}`);

        // Mark file as processed (idempotency)
        await sourceFile.setMetadata({
            metadata: { transcriptionStarted: new Date().toISOString() }
        });

        // Only send email AFTER job successfully started (prevents duplicate emails on retry)
        await sendEmail('Transcription Started', `Processing file: ${file.name}\nWe'll notify you when it's done.`);

    } catch (err) {
        console.error(`Failed to start video transcription for ${file.name}:`, err);
    }
});

async function sendEmail(subject, text) {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    const to = process.env.NOTIFICATION_EMAIL;

    if (!user || !pass || !to) {
        console.log('Skipping email (missing creds).');
        return;
    }

    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user, pass }
    });

    await transporter.sendMail({
        from: user,
        to: to,
        subject: `[Drive Automation] ${subject}`,
        text: text
    });
}
