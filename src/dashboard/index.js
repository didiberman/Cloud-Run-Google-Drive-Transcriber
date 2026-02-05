const functions = require('@google-cloud/functions-framework');
const { Storage } = require('@google-cloud/storage');

const storage = new Storage();

const TRANSCRIPT_BUCKET = process.env.TRANSCRIPT_BUCKET;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'tmptmp123';

const PROMPT_CONFIG_FILE = '_config/prompt.txt';
const MODEL_CONFIG_FILE = '_config/model.txt';

const AVAILABLE_MODELS = [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google', description: 'Fast & cost-effective' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google', description: 'Most capable Gemini' },
    { id: 'claude-sonnet-4@20250514', name: 'Claude Sonnet 4', provider: 'anthropic', description: 'Balanced performance' },
    { id: 'claude-opus-4@20250115', name: 'Claude Opus 4', provider: 'anthropic', description: 'Most capable Claude' }
];

// Register HTTP function
functions.http('dashboard', async (req, res) => {
    // Check for password in URL query parameter first (e.g., ?p=dashboard)
    const urlPassword = req.query.p || req.query.password;

    if (urlPassword === DASHBOARD_PASSWORD) {
        // URL password is valid, proceed
    } else {
        // Fall back to Basic authentication
        const auth = req.headers.authorization;

        if (!auth || !auth.startsWith('Basic ')) {
            res.setHeader('WWW-Authenticate', 'Basic realm="Transcription Dashboard"');
            return res.status(401).send('Authentication required. Or use ?p=PASSWORD in URL.');
        }

        const credentials = Buffer.from(auth.split(' ')[1], 'base64').toString();
        const [username, password] = credentials.split(':');

        if (password !== DASHBOARD_PASSWORD) {
            res.setHeader('WWW-Authenticate', 'Basic realm="Transcription Dashboard"');
            return res.status(401).send('Invalid credentials');
        }
    }

    try {
        if (!TRANSCRIPT_BUCKET) {
            return res.status(500).send('TRANSCRIPT_BUCKET not configured');
        }

        const bucket = storage.bucket(TRANSCRIPT_BUCKET);

        // Handle POST request to save settings
        if (req.method === 'POST' && req.body && req.body.action === 'saveSettings') {
            const promptContent = req.body.prompt || '';
            const modelId = req.body.model || 'gemini-2.5-flash';

            await Promise.all([
                bucket.file(PROMPT_CONFIG_FILE).save(promptContent, { contentType: 'text/plain; charset=utf-8' }),
                bucket.file(MODEL_CONFIG_FILE).save(modelId, { contentType: 'text/plain; charset=utf-8' })
            ]);

            return res.json({ success: true, message: 'Settings saved successfully' });
        }

        // Load current settings from GCS
        let currentPrompt = '';
        let currentModel = 'gemini-2.5-flash';
        try {
            const [promptData] = await bucket.file(PROMPT_CONFIG_FILE).download();
            currentPrompt = promptData.toString();
        } catch (e) {
            // No prompt file yet, that's okay
        }
        try {
            const [modelData] = await bucket.file(MODEL_CONFIG_FILE).download();
            currentModel = modelData.toString().trim();
        } catch (e) {
            // No model file yet, use default
        }

        const [files] = await bucket.getFiles();

        // Build a set of all file names for quick lookup
        const fileNames = new Set(files.map(f => f.name));

        // Filter for TRANSCRIPT files only (one entry per video)
        const transcripts = [];
        for (const file of files) {
            if (file.name.endsWith('_TRANSCRIPT.txt') && !file.name.startsWith('_config/')) {
                const [metadata] = await file.getMetadata();
                // Extract video name: "video.mp4_TRANSCRIPT.txt" -> "video.mp4"
                const videoName = file.name.replace(/_TRANSCRIPT\.txt$/, '');
                const jsonName = videoName + '.json';
                const analysisName = videoName + '_ANALYSIS.txt';
                const hasAnalysis = fileNames.has(analysisName);

                transcripts.push({
                    name: file.name,
                    videoName: videoName,
                    created: metadata.timeCreated,
                    size: formatBytes(parseInt(metadata.size)),
                    transcriptLink: `https://storage.cloud.google.com/${TRANSCRIPT_BUCKET}/${file.name}`,
                    analysisLink: hasAnalysis ? `https://storage.cloud.google.com/${TRANSCRIPT_BUCKET}/${analysisName}` : null,
                    jsonLink: `https://storage.cloud.google.com/${TRANSCRIPT_BUCKET}/${jsonName}`
                });
            }
        }

        // Sort by date (newest first)
        transcripts.sort((a, b) => new Date(b.created) - new Date(a.created));

        // Generate HTML
        const html = generateDashboard(transcripts, currentPrompt, currentModel);
        res.send(html);

    } catch (err) {
        console.error('Dashboard error:', err);
        res.status(500).send(`Error: ${err.message}`);
    }
});

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(isoString) {
    const date = new Date(isoString);
    return date.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short'
    });
}

function generateDashboard(transcripts, currentPrompt = '', currentModel = 'gemini-2.5-flash') {
    const modelOptions = AVAILABLE_MODELS.map(m =>
        `<option value="${m.id}" ${m.id === currentModel ? 'selected' : ''}>${m.name} - ${m.description}</option>`
    ).join('');

    const rows = transcripts.map((t, i) => `
        <tr>
            <td>${i + 1}</td>
            <td>${escapeHtml(t.videoName)}</td>
            <td>${formatDate(t.created)}</td>
            <td>${t.size}</td>
            <td>
                <a href="${t.transcriptLink}" target="_blank">Transcript</a>
                ${t.analysisLink ? `&nbsp;|&nbsp;<a href="${t.analysisLink}" target="_blank" style="color: #4ade80;">Analysis</a>` : ''}
                &nbsp;|&nbsp;
                <a href="${t.jsonLink}" target="_blank" style="color: #888;">JSON</a>
            </td>
        </tr>
    `).join('');

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Transcription Dashboard</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            color: #eee;
            padding: 20px;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        header {
            text-align: center;
            padding: 40px 0;
        }
        h1 {
            font-size: 2.5rem;
            margin-bottom: 10px;
            background: linear-gradient(90deg, #00d4ff, #7b2cbf);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .stats {
            display: flex;
            gap: 20px;
            justify-content: center;
            margin-bottom: 40px;
        }
        .stat-card {
            background: rgba(255,255,255,0.1);
            border-radius: 12px;
            padding: 20px 40px;
            text-align: center;
            backdrop-filter: blur(10px);
        }
        .stat-number {
            font-size: 2.5rem;
            font-weight: bold;
            color: #00d4ff;
        }
        .stat-label {
            font-size: 0.9rem;
            color: #aaa;
            margin-top: 5px;
        }
        .settings-section {
            background: rgba(255,255,255,0.08);
            border-radius: 12px;
            padding: 25px;
            margin-bottom: 40px;
            backdrop-filter: blur(10px);
        }
        .settings-section h2 {
            color: #00d4ff;
            margin-bottom: 15px;
            font-size: 1.3rem;
        }
        .settings-section p {
            color: #aaa;
            font-size: 0.9rem;
            margin-bottom: 15px;
        }
        .prompt-textarea {
            width: 100%;
            min-height: 200px;
            background: rgba(0,0,0,0.3);
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 8px;
            padding: 15px;
            color: #eee;
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 0.9rem;
            resize: vertical;
            margin-bottom: 15px;
        }
        .prompt-textarea:focus {
            outline: none;
            border-color: #00d4ff;
        }
        .model-select {
            width: 100%;
            background: rgba(0,0,0,0.3);
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 8px;
            padding: 12px 15px;
            color: #eee;
            font-size: 0.95rem;
            margin-bottom: 20px;
            cursor: pointer;
        }
        .model-select:focus {
            outline: none;
            border-color: #00d4ff;
        }
        .model-select option {
            background: #1a1a2e;
            color: #eee;
        }
        .settings-row {
            margin-bottom: 20px;
        }
        .settings-label {
            display: block;
            color: #ccc;
            font-size: 0.9rem;
            margin-bottom: 8px;
            font-weight: 500;
        }
        .btn {
            background: linear-gradient(90deg, #00d4ff, #7b2cbf);
            border: none;
            padding: 12px 30px;
            border-radius: 8px;
            color: white;
            font-weight: 600;
            cursor: pointer;
            font-size: 0.95rem;
            transition: opacity 0.2s;
        }
        .btn:hover {
            opacity: 0.9;
        }
        .btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .save-status {
            display: inline-block;
            margin-left: 15px;
            font-size: 0.9rem;
        }
        .save-status.success {
            color: #4ade80;
        }
        .save-status.error {
            color: #f87171;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            background: rgba(255,255,255,0.05);
            border-radius: 12px;
            overflow: hidden;
        }
        th, td {
            padding: 15px 20px;
            text-align: left;
        }
        th {
            background: rgba(0,212,255,0.2);
            font-weight: 600;
            text-transform: uppercase;
            font-size: 0.85rem;
            letter-spacing: 0.5px;
        }
        tr:nth-child(even) {
            background: rgba(255,255,255,0.03);
        }
        tr:hover {
            background: rgba(0,212,255,0.1);
        }
        a {
            color: #00d4ff;
            text-decoration: none;
        }
        a:hover {
            text-decoration: underline;
        }
        .empty {
            text-align: center;
            padding: 60px;
            color: #888;
        }
        .refresh {
            text-align: center;
            margin-top: 20px;
            color: #666;
            font-size: 0.85rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Video Transcription Dashboard</h1>
            <p style="color: #888;">Google Drive Automation Pipeline</p>
        </header>

        <div class="settings-section">
            <h2>AI Analysis Settings</h2>
            <p>Configure the AI model and prompt used for analyzing your video transcripts.</p>

            <div class="settings-row">
                <label class="settings-label">AI Model</label>
                <select id="modelSelect" class="model-select">
                    ${modelOptions}
                </select>
            </div>

            <div class="settings-row">
                <label class="settings-label">Analysis Prompt</label>
                <textarea id="promptInput" class="prompt-textarea" placeholder="Enter your analysis prompt here...&#10;&#10;Example: Summarize this video transcript. Identify the main topics discussed and list any action items mentioned.">${escapeHtml(currentPrompt)}</textarea>
            </div>

            <button id="saveSettingsBtn" class="btn" onclick="saveSettings()">Save Settings</button>
            <span id="saveStatus" class="save-status"></span>
        </div>

        <div class="stats">
            <div class="stat-card">
                <div class="stat-number">${transcripts.length}</div>
                <div class="stat-label">Total Transcripts</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">${transcripts.length > 0 ? formatDate(transcripts[0].created).split(',')[0] : 'N/A'}</div>
                <div class="stat-label">Last Processed</div>
            </div>
        </div>

        ${transcripts.length === 0 ? `
            <div class="empty">
                <p>No transcripts yet. Upload a video to your Google Drive folder to get started.</p>
            </div>
        ` : `
            <table>
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Video Name</th>
                        <th>Processed At</th>
                        <th>Size</th>
                        <th>Links</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
        `}

        <p class="refresh">Refresh page to see latest transcripts</p>
    </div>

    <script>
        async function saveSettings() {
            const btn = document.getElementById('saveSettingsBtn');
            const status = document.getElementById('saveStatus');
            const promptText = document.getElementById('promptInput').value;
            const modelId = document.getElementById('modelSelect').value;

            btn.disabled = true;
            status.textContent = 'Saving...';
            status.className = 'save-status';

            try {
                const response = await fetch(window.location.href, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        action: 'saveSettings',
                        prompt: promptText,
                        model: modelId
                    })
                });

                const result = await response.json();

                if (result.success) {
                    status.textContent = 'Saved!';
                    status.className = 'save-status success';
                } else {
                    status.textContent = 'Error: ' + (result.message || 'Unknown error');
                    status.className = 'save-status error';
                }
            } catch (err) {
                status.textContent = 'Error: ' + err.message;
                status.className = 'save-status error';
            }

            btn.disabled = false;
            setTimeout(() => { status.textContent = ''; }, 3000);
        }
    </script>
</body>
</html>
    `;
}

function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
