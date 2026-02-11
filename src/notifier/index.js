const { Storage } = require('@google-cloud/storage');
const { google } = require('googleapis');
const functions = require('@google-cloud/functions-framework');
const { Readable } = require('stream');
const { VertexAI } = require('@google-cloud/vertexai');
const { GoogleAuth } = require('google-auth-library');

// Model configuration
const MODEL_CONFIG_FILE = '_config/model.txt';
const DEFAULT_MODEL = 'gemini-2.5-flash';

// Lazy-initialized clients
let vertexAI = null;
let googleAuth = null;

function getProjectConfig() {
    const projectId = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
    const location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

    if (!projectId) {
        throw new Error('GCP_PROJECT or GOOGLE_CLOUD_PROJECT environment variable not set.');
    }

    return { projectId, location };
}

function getVertexAI() {
    if (vertexAI) return vertexAI;
    const { projectId, location } = getProjectConfig();
    vertexAI = new VertexAI({ project: projectId, location });
    return vertexAI;
}

function getGoogleAuth() {
    if (googleAuth) return googleAuth;
    googleAuth = new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
    return googleAuth;
}

async function callClaudeOnVertex(prompt, modelId) {
    const { projectId, location } = getProjectConfig();
    const auth = getGoogleAuth();
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    // Claude on Vertex AI endpoint
    const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/anthropic/models/${modelId}:rawPredict`;

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken.token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            anthropic_version: 'vertex-2023-10-16',
            max_tokens: 4096,
            messages: [{
                role: 'user',
                content: prompt
            }]
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Claude API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();

    // Extract text from Claude response
    if (result.content && Array.isArray(result.content)) {
        return result.content
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('');
    }

    throw new Error('Unexpected response structure from Claude');
}

async function analyzeWithModel(transcript, prompt, modelId) {
    const fullPrompt = `${prompt}\n\nTranscript:\n${transcript}`;

    // Determine if it's a Gemini or Claude model
    if (modelId.startsWith('claude')) {
        // Claude model via Vertex AI REST API
        console.log(`Using Claude model: ${modelId}`);
        return await callClaudeOnVertex(fullPrompt, modelId);

    } else {
        // Gemini model via Vertex AI SDK
        console.log(`Using Gemini model: ${modelId}`);
        const ai = getVertexAI();
        const model = ai.getGenerativeModel({ model: modelId });

        const result = await model.generateContent(fullPrompt);
        const response = result.response;

        // Extract text from Vertex AI response structure
        if (response.candidates && response.candidates[0] && response.candidates[0].content) {
            const parts = response.candidates[0].content.parts;
            return parts.map(part => part.text).join('');
        }

        throw new Error('Unexpected response structure from Vertex AI');
    }
}

const storage = new Storage();
const drive = google.drive({ version: 'v3' });
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
        const videoDuration = getVideoDuration(transcriptData);

        let transcriptContent = null;
        let analysisText = null;
        let selectedModel = DEFAULT_MODEL; // Declare here so it's accessible in all code paths
        let subject = `Analysis & Transcript: ${file.name.replace(/\.json$/, '')}`;
        let emailBody = '';

        // Check for empty or very short transcript (under 10 words)
        // We strip timestamps "[0:00 - 0:05]" (approximate check) to count actual speech words
        const speechOnly = formattedTranscript ? formattedTranscript.replace(/\[\d+:\d+ - \d+:\d+\]/g, '').trim() : '';
        const wordCount = speechOnly.split(/\s+/).length;
        const isInsufficient = !formattedTranscript || wordCount < 10;

        if (isInsufficient) {
            console.warn(`Transcript insufficient (${wordCount} words) for ${file.name}. Skipping AI analysis.`);

            subject = `Transcript Empty / Failed: ${file.name.replace(/\.json$/, '')}`;
            emailBody = `Your video "${file.name.replace(/\.json$/, '')}" has been processed.\n\n` +
                `Video Duration: ${videoDuration}\n\n` +
                `Status: No significant speech detected (${wordCount} words).\n` +
                `AI analysis was skipped because there is not enough content to analyze.\n\n` +
                `This could be because the video is silent, the audio is unclear, or the speech is very brief.`;

            // We still save a "transcript" file effectively saying it failed, so the dashboard shows something
            transcriptContent = `Video: ${file.name.replace(/\.json$/, '')}\n` +
                `Duration: ${videoDuration}\n` +
                `Processed: ${new Date().toISOString()}\n\n` +
                `═══════════════════════════════════════════════════════\n` +
                `TRANSCRIPT STATUS: INSUFFICIENT DATA\n` +
                `═══════════════════════════════════════════════════════\n\n` +
                `No significant speech detected in this video (${wordCount} words).`;

        } else {
            console.log(`Transcript extracted (${formattedTranscript.length} chars), duration: ${videoDuration}`);

            // 2.5 Prepare Content (including optional AI Analysis)

            // Run Analysis - check GCS config first, then fall back to Google Drive
            const PROMPT_CONFIG_FILE = '_config/prompt.txt';
            const MAIN_WATCHED_FOLDER_ID = process.env.FOLDER_ID;
            const PROMPT_FOLDER_CANDIDATES = ['_prompts', 'THE PROMPT'];
            const PROMPT_FILE_CANDIDATES = ['PROMPT.md', 'PROMPT.MD', 'prompt.md'];

            try {
                let promptContent = null;
                selectedModel = DEFAULT_MODEL; // Reset to default, may be overridden below

                // 1. First, try to load settings from GCS (set via dashboard)
                try {
                    const [promptData] = await bucket.file(PROMPT_CONFIG_FILE).download();
                    const gcsPrompt = promptData.toString().trim();
                    if (gcsPrompt) {
                        console.log('Found prompt in GCS config. Using dashboard-configured prompt.');
                        promptContent = gcsPrompt;
                    }
                } catch (gcsErr) {
                    // No GCS prompt file, that's okay - fall back to Drive
                    console.log('No GCS prompt config found, checking Google Drive...');
                }

                // Load model selection from GCS
                try {
                    const [modelData] = await bucket.file(MODEL_CONFIG_FILE).download();
                    const gcsModel = modelData.toString().trim();
                    if (gcsModel) {
                        selectedModel = gcsModel;
                        console.log(`Using dashboard-configured model: ${selectedModel}`);
                    }
                } catch (modelErr) {
                    console.log(`No model config found, using default: ${DEFAULT_MODEL}`);
                }

                // 2. Fall back to Google Drive prompt if GCS is empty
                if (!promptContent && MAIN_WATCHED_FOLDER_ID) {
                    console.log(`Searching Google Drive folder: ${MAIN_WATCHED_FOLDER_ID}`);
                    promptContent = await locatePromptContent(
                        MAIN_WATCHED_FOLDER_ID,
                        PROMPT_FOLDER_CANDIDATES,
                        PROMPT_FILE_CANDIDATES
                    );
                } else if (!promptContent && !MAIN_WATCHED_FOLDER_ID) {
                    console.warn('FOLDER_ID env var not set and no GCS prompt. Skipping AI analysis.');
                }

                if (promptContent) {
                    console.log(`Found prompt template. Running AI analysis with ${selectedModel}...`);
                    analysisText = await analyzeWithModel(formattedTranscript, promptContent, selectedModel);
                    console.log('AI Analysis complete.');
                } else {
                    console.log('No prompt template found. Skipping AI analysis.');
                }
            } catch (aiErr) {
                console.error('Error during AI analysis:', aiErr);
                analysisText = `[Error during AI Analysis: ${aiErr.message}]`;
            }

            // 3. Prepare Valid Content
            transcriptContent = `Video: ${file.name.replace(/\.json$/, '')}\n` +
                `Duration: ${videoDuration}\n` +
                `Processed: ${new Date().toISOString()}\n\n` +
                `═══════════════════════════════════════════════════════\n` +
                `TRANSCRIPT\n` +
                `═══════════════════════════════════════════════════════\n\n` +
                `${formattedTranscript}`;

            subject = `[Drive Automation] Analysis & Transcript: ${file.name.replace(/\.json$/, '')}`;

            const gcsLink = `https://storage.cloud.google.com/${process.env.TRANSCRIPT_BUCKET || 'BUCKET_UNKNOWN'}/${file.name}`;

            emailBody = `Your video "${file.name.replace(/\.json$/, '')}" has been processed!\n\n` +
                `Video Duration: ${videoDuration}\n\n`;

            emailBody += `The transcript and AI analysis are attached to this email.\n\n`;

            if (analysisText) {
                emailBody += `═══════════════════════════════════════════════════════\n` +
                    `AI ANALYSIS\n` +
                    `═══════════════════════════════════════════════════════\n\n` +
                    `${analysisText}\n\n`;
            }

            emailBody += `═══════════════════════════════════════════════════════\n` +
                `LINKS\n` +
                `═══════════════════════════════════════════════════════\n\n` +
                `Raw JSON: ${gcsLink}\n\n` +
                `To view the full transcript or analysis, open the attached files.`;
        }

        const transcriptFileName = file.name.replace(/\.json$/, '_TRANSCRIPT.txt');

        let analysisFileName = null;
        let analysisContent = null;

        if (analysisText) {
            analysisFileName = file.name.replace(/\.json$/, '_ANALYSIS.txt');
            analysisContent = `Video: ${file.name.replace(/\.json$/, '')}\n` +
                `Duration: ${videoDuration}\n` +
                `Processed: ${new Date().toISOString()}\n\n` +
                `═══════════════════════════════════════════════════════\n` +
                `AI ANALYSIS\n` +
                `═══════════════════════════════════════════════════════\n\n` +
                `${analysisText}`;
        }

        // Save Transcript to GCS
        await bucket.file(transcriptFileName).save(transcriptContent, {
            contentType: 'text/plain; charset=utf-8'
        });
        console.log(`Saved transcript to GCS: ${transcriptFileName}`);

        // Save Analysis to GCS (if available)
        if (analysisFileName && analysisContent) {
            await bucket.file(analysisFileName).save(analysisContent, {
                contentType: 'text/plain; charset=utf-8'
            });
            console.log(`Saved analysis to GCS: ${analysisFileName}`);
        }

        // 4. Send Notification
        await sendEmailOrSMS(
            file.name, // Original JSON filename for reference
            subject,
            emailBody,
            transcriptContent,
            transcriptFileName,
            analysisContent,
            analysisFileName,
            selectedModel // Pass the model name
        );

        // Mark as notified (idempotency)
        await transcriptFile.setMetadata({
            metadata: { notificationSent: new Date().toISOString() }
        });

        // 6. Cleanup: Delete the source video from input bucket
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
 * Extracts video duration from the Video Intelligence API response.
 * @param {Object} transcriptData - The parsed JSON from Video Intelligence API
 * @returns {string} Formatted duration (e.g., "5 min 32 sec" or "1 hr 23 min")
 */
function getVideoDuration(transcriptData) {
    try {
        const annotationResults = transcriptData.annotation_results;
        if (!annotationResults || annotationResults.length === 0) {
            return 'Unknown';
        }

        const segment = annotationResults[0].segment;
        if (!segment || !segment.end_time_offset) {
            return 'Unknown';
        }

        const endTime = segment.end_time_offset;
        const totalSeconds = parseInt(endTime.seconds || 0) + (endTime.nanos || 0) / 1e9;

        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = Math.floor(totalSeconds % 60);

        if (hours > 0) {
            return `${hours} hr ${minutes} min`;
        } else if (minutes > 0) {
            return `${minutes} min ${seconds} sec`;
        } else {
            return `${seconds} sec`;
        }
    } catch (e) {
        return 'Unknown';
    }
}

/**
 * Formats the Video Intelligence API response into human-readable transcript with timing.
 * Note: The API returns snake_case keys (annotation_results, speech_transcriptions, etc.)
 * @param {Object} transcriptData - The parsed JSON from Video Intelligence API
 * @returns {string|null} Formatted transcript with timing, or NULL if empty/failed
 */
function formatTranscript(transcriptData) {
    const paragraphs = [];

    // API uses snake_case: annotation_results
    const annotationResults = transcriptData.annotation_results;
    if (!annotationResults || annotationResults.length === 0) {
        return null;
    }

    const annotations = annotationResults[0];
    // API uses snake_case: speech_transcriptions
    if (!annotations.speech_transcriptions || annotations.speech_transcriptions.length === 0) {
        return null;
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
        return null;
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

async function sendEmailOrSMS(originalFilename, subject, text, transcriptContent, transcriptFileName, analysisContent, analysisFileName, modelName) {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    const to = process.env.NOTIFICATION_EMAIL;
    const dashboardUrl = process.env.DASHBOARD_URL;

    console.log('---------------------------------------------------');
    console.log(`NOTIFICATION for ${originalFilename}`);
    console.log(`SUBJECT: ${subject}`);
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

    // Append Model Info and Dashboard Link
    let finalText = text;

    finalText += `\n═══════════════════════════════════════════════════════\n` +
        `SYSTEM INFO\n` +
        `═══════════════════════════════════════════════════════\n\n`;

    if (modelName) {
        finalText += `AI Model used: ${modelName}\n`;
    }

    if (dashboardUrl) {
        finalText += `Dashboard: ${dashboardUrl}\n`;
    } else {
        finalText += `Dashboard: (URL not configured)\n`;
    }

    // Attachments
    const attachments = [];
    if (transcriptContent && transcriptFileName) {
        attachments.push({
            filename: transcriptFileName,
            content: transcriptContent
        });
    }
    if (analysisContent && analysisFileName) {
        attachments.push({
            filename: analysisFileName,
            content: analysisContent
        });
    }

    await transporter.sendMail({
        from: user,
        to: to,
        subject: subject,
        text: finalText,
        attachments: attachments
    });
}

/**
 * Sanitizes a Google Drive folder ID by removing trailing underscores.
 * Trailing underscores can cause Drive API 404 errors.
 * @param {string} folderId - The folder ID to sanitize
 * @returns {string} The sanitized folder ID
 */
function sanitizeParentFolderId(folderId) {
    if (!folderId) {
        return folderId;
    }

    const trimmed = folderId.trim();
    const sanitized = trimmed.replace(/_+$/, '');

    if (sanitized !== trimmed) {
        console.log(`Sanitized parentFolderId: "${trimmed}" -> "${sanitized}"`);
    }

    return sanitized;
}

function getFolderIdCandidates(folderId) {
    if (!folderId) {
        return [];
    }

    const trimmed = folderId.trim();
    const sanitized = sanitizeParentFolderId(trimmed);
    const candidates = [trimmed];

    if (sanitized && sanitized !== trimmed) {
        candidates.push(sanitized);
    }

    return Array.from(new Set(candidates)).filter(Boolean);
}

function escapeDriveQueryValue(value) {
    return value.replace(/'/g, "\\'");
}

/**
 * Attempts to locate a prompt template inside known subfolders or directly in the
 * watched root folder.
 * @param {string} rootFolderId - The root Drive folder that is being monitored
 * @param {string[]} folderCandidates - List of folder names to look for (in order)
 * @param {string[]} fileCandidates - List of acceptable prompt file names
 * @returns {Promise<string|null>} Prompt contents or null if none found
 */
async function locatePromptContent(rootFolderId, folderCandidates, fileCandidates) {
    for (const folderName of folderCandidates) {
        console.log(`Searching for prompt folder '${folderName}' in: ${rootFolderId}`);
        const promptFolderId = await findSubfolderId(rootFolderId, folderName);
        if (!promptFolderId) {
            continue;
        }

        console.log(`Found prompt folder '${folderName}' (${promptFolderId}). Looking for prompt file...`);
        const promptContent = await findPromptFile(promptFolderId, fileCandidates);
        if (promptContent) {
            return promptContent;
        }
        console.log(`No prompt file found inside ${folderName}.`);
    }

    console.log('Prompt subfolders not found. Searching for prompt file directly in root folder...');
    return await findPromptFile(rootFolderId, fileCandidates);
}

/**
 * Searches for a file using any of the provided candidate names.
 * @param {string} folderId - The folder to search in
 * @param {string|string[]} fileNames - Acceptable file names (case variations)
 * @returns {Promise<string|null>} The content of the file, or null if not found
 */
async function findPromptFile(folderId, fileNames) {
    const folderCandidates = getFolderIdCandidates(folderId);
    if (folderCandidates.length === 0) {
        console.warn('No folder ID provided to findPromptFile.');
        return null;
    }
    const candidates = Array.isArray(fileNames) ? fileNames : [fileNames];
    if (candidates.length === 0) {
        return null;
    }

    const escapedNames = candidates.map(name => `name = '${escapeDriveQueryValue(name)}'`).join(' or ');

    // Ensure the global Drive client is authenticated (ADC handles credentials in Cloud Functions)

    const auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/drive.readonly']
    });
    const authClient = await auth.getClient();
    google.options({ auth: authClient });

    try {
        for (const candidateFolderId of folderCandidates) {
            const res = await drive.files.list({
                q: `'${candidateFolderId}' in parents and trashed = false and (${escapedNames})`,
                fields: 'files(id, name)',
                pageSize: 1
            });

            const files = res.data.files;
            if (!files || files.length === 0) {
                console.log(`Prompt file ${candidates.join(', ')} not found in folder ${candidateFolderId}`);
                continue;
            }

            const fileId = files[0].id;
            console.log(`Found prompt file ${files[0].name} (${fileId})`);

            // Download content
            const fileRes = await drive.files.get({
                fileId: fileId,
                alt: 'media'
            }, { responseType: 'stream' });

            return new Promise((resolve, reject) => {
                let data = '';
                fileRes.data
                    .on('data', chunk => data += chunk)
                    .on('end', () => resolve(data))
                    .on('error', err => reject(err));
            });
        }

        return null;

    } catch (err) {
        console.warn(`Error searching for prompt file in ${folderId}:`, err.message);
        return null; // Fail gracefully (skip analysis)
    }
}


/**
 * Searches for a subfolder by name in the specified parent folder.
 * @param {string} parentFolderId 
 * @param {string} subfolderName 
 * @returns {Promise<string|null>} The folder ID, or null if not found
 */
async function findSubfolderId(parentFolderId, subfolderName) {
    const folderCandidates = getFolderIdCandidates(parentFolderId);
    if (folderCandidates.length === 0) {
        console.warn('No parent folder ID provided to findSubfolderId.');
        return null;
    }

    const auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/drive.readonly']
    });
    const authClient = await auth.getClient();
    google.options({ auth: authClient });

    try {
        for (const candidateId of folderCandidates) {
            const res = await drive.files.list({
                q: `'${candidateId}' in parents and name = '${subfolderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
                fields: 'files(id, name)',
                pageSize: 1
            });

            if (res.data.files && res.data.files.length > 0) {
                return res.data.files[0].id;
            }
        }
        return null;
    } catch (err) {
        console.warn(`Error searching for subfolder '${subfolderName}' in ${parentFolderId}:`, err.message);
        return null;
    }
}

// Export functions for testing
module.exports = {
    sanitizeParentFolderId,
    formatTime,
    getVideoDuration,
    formatTranscript,
    findSubfolderId // Export for testing if needed
};
