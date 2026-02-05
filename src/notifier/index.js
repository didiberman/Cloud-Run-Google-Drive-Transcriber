const { Storage } = require('@google-cloud/storage');
const functions = require('@google-cloud/functions-framework');

const storage = new Storage();
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL;
const INPUT_BUCKET = process.env.INPUT_BUCKET;

functions.cloudEvent('sendNotification', async (cloudEvent) => {
    const file = cloudEvent.data;

    console.log(`Received transcript file: ${file.name} in bucket ${file.bucket}`);

    if (!file.name.endsWith('.json')) {
        console.log('Not a JSON file, skipping.');
        return;
    }

    try {
        // Idempotency check: Skip if already notified
        const bucket = storage.bucket(file.bucket);
        const transcriptFile = bucket.file(file.name);
        const [metadata] = await transcriptFile.getMetadata();
        if (metadata.metadata && metadata.metadata.notificationSent) {
            console.log(`Skipping already-notified file: ${file.name}`);
            return;
        }

        // 1. Download the transcript JSON
        const [content] = await transcriptFile.download();

        const transcriptData = JSON.parse(content.toString());

        // 2. Extract Text (Video Intelligence Format)
        // Format: { annotationResults: [ { speechTranscriptions: [ { alternatives: [ { transcript: '...' } ] } ] } ] }
        let fullText = '';

        if (transcriptData.annotationResults && transcriptData.annotationResults.length > 0) {
            const annotations = transcriptData.annotationResults[0];
            if (annotations.speechTranscriptions) {
                fullText = annotations.speechTranscriptions
                    .map(transcription => {
                        // Each transcription has 'alternatives'. We usually want the first one.
                        if (transcription.alternatives && transcription.alternatives.length > 0) {
                            return transcription.alternatives[0].transcript;
                        }
                        return '';
                    })
                    .join(' '); // Video transcripts are often fragmented sentence-wise
            }
        }

        const preview = fullText.substring(0, 200) + '...';
        console.log(`Transcript extracted (${fullText.length} chars). Preview: ${preview}`);

        // 3. Send Notification
        await sendEmailOrSMS(fullText, file.name);

        // Mark as notified (idempotency)
        await transcriptFile.setMetadata({
            metadata: { notificationSent: new Date().toISOString() }
        });

        // 4. Cleanup: Delete the source video from input bucket
        if (INPUT_BUCKET) {
            // Transcript filename is "video.mp4.json", original is "video.mp4"
            const originalFileName = file.name.replace(/\.json$/, '');
            try {
                await storage.bucket(INPUT_BUCKET).file(originalFileName).delete();
                console.log(`Cleaned up source file: ${originalFileName} from ${INPUT_BUCKET}`);
            } catch (cleanupErr) {
                console.warn(`Failed to cleanup source file ${originalFileName}:`, cleanupErr.message);
            }
        }

    } catch (err) {
        console.error('Error processing transcript:', err);
    }
});

async function sendEmailOrSMS(text, fileName) {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    const to = process.env.NOTIFICATION_EMAIL;

    console.log('---------------------------------------------------');
    console.log(`NOTIFICATION for ${fileName}`);
    console.log(`TO: ${to || 'Log Only'}`);
    console.log(`MESSAGE PREVIEW: \n${text.substring(0, 100)}...`);
    console.log('---------------------------------------------------');

    if (!user || !pass || !to) {
        console.warn('No GMAIL_USER/PASS or NOTIFICATION_EMAIL env var set. Skipping actual send.');
        return;
    }

    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user, pass }
    });

    const gcsLink = `https://storage.cloud.google.com/${process.env.TRANSCRIPT_BUCKET || 'BUCKET_UNKNOWN'}/${fileName}`;

    await transporter.sendMail({
        from: user,
        to: to,
        subject: `[Drive Automation] Transcript Ready: ${fileName}`,
        text: `Your video has been transcribed!\n\nView Full JSON Source: ${gcsLink}\n\nPreview:\n${text.substring(0, 2000)}...`
    });
}
