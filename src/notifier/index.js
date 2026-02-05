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

        // 2. Extract Text with Timing (Video Intelligence Format)
        const formattedTranscript = formatTranscript(transcriptData);
        console.log(`Transcript extracted (${formattedTranscript.length} chars)`);

        // 3. Send Notification
        await sendEmailOrSMS(formattedTranscript, file.name);

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

/**
 * Formats the Video Intelligence API response into human-readable transcript with timing.
 * Note: The API returns snake_case keys (annotation_results, speech_transcriptions, etc.)
 * @param {Object} transcriptData - The parsed JSON from Video Intelligence API
 * @returns {string} Formatted transcript with timing
 */
function formatTranscript(transcriptData) {
    const paragraphs = [];

    // API uses snake_case: annotation_results
    const annotationResults = transcriptData.annotation_results;
    if (!annotationResults || annotationResults.length === 0) {
        return 'No transcript data found.';
    }

    const annotations = annotationResults[0];
    // API uses snake_case: speech_transcriptions
    if (!annotations.speech_transcriptions || annotations.speech_transcriptions.length === 0) {
        return 'No speech detected in video.';
    }

    for (const transcription of annotations.speech_transcriptions) {
        if (!transcription.alternatives || transcription.alternatives.length === 0) {
            continue;
        }

        const alternative = transcription.alternatives[0];
        const transcript = alternative.transcript;

        if (!transcript || transcript.trim() === '') {
            continue;
        }

        // Get timing from words array if available
        let startTime = '0:00';
        let endTime = '0:00';

        if (alternative.words && alternative.words.length > 0) {
            const firstWord = alternative.words[0];
            const lastWord = alternative.words[alternative.words.length - 1];

            // API uses snake_case: start_time, end_time
            startTime = formatTime(firstWord.start_time);
            endTime = formatTime(lastWord.end_time);
        }

        paragraphs.push(`[${startTime} - ${endTime}]\n${transcript.trim()}`);
    }

    if (paragraphs.length === 0) {
        return 'No transcript content found.';
    }

    return paragraphs.join('\n\n');
}

/**
 * Converts Video Intelligence time format to human-readable MM:SS or HH:MM:SS
 * @param {string|Object} time - Time in format "123.456s" or {seconds: 123, nanos: 456000000}
 * @returns {string} Formatted time string
 */
function formatTime(time) {
    if (!time) return '0:00';

    let totalSeconds = 0;

    if (typeof time === 'string') {
        // Format: "123.456s"
        totalSeconds = parseFloat(time.replace('s', ''));
    } else if (typeof time === 'object') {
        // Format: {seconds: "123", nanos: 456000000}
        totalSeconds = parseInt(time.seconds || 0) + (time.nanos || 0) / 1e9;
    }

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);

    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

async function sendEmailOrSMS(text, fileName) {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    const to = process.env.NOTIFICATION_EMAIL;

    // Extract video name (remove .json extension)
    const videoName = fileName.replace(/\.json$/, '');

    console.log('---------------------------------------------------');
    console.log(`NOTIFICATION for ${videoName}`);
    console.log(`TO: ${to || 'Log Only'}`);
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
        subject: `[Drive Automation] Transcript: ${videoName}`,
        text: `Your video "${videoName}" has been transcribed!\n\n` +
              `═══════════════════════════════════════════════════════\n` +
              `TRANSCRIPT\n` +
              `═══════════════════════════════════════════════════════\n\n` +
              `${text}\n\n` +
              `═══════════════════════════════════════════════════════\n\n` +
              `View raw JSON: ${gcsLink}`
    });
}
