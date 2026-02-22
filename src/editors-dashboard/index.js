const functions = require('@google-cloud/functions-framework');
const { Storage } = require('@google-cloud/storage');

const storage = new Storage();

const TRANSCRIPT_BUCKET = process.env.TRANSCRIPT_BUCKET;

// Register HTTP function — no authentication required
functions.http('editorsDashboard', async (req, res) => {
    try {
        if (!TRANSCRIPT_BUCKET) {
            return res.status(500).send('TRANSCRIPT_BUCKET not configured');
        }

        const transcriptBucket = storage.bucket(TRANSCRIPT_BUCKET);

        const [files] = await transcriptBucket.getFiles();

        // Build a set of all file names for O(1) lookups
        const fileNames = new Set(files.map(f => f.name));
        const fileMap = new Map(files.map(f => [f.name, f]));

        // Only include videos that have an _ANALYSIS.txt file
        const analysisFiles = files.filter(f => f.name.endsWith('_ANALYSIS.txt') && !f.name.startsWith('_config/'));

        // Download the first 200 bytes of each analysis file in parallel to extract duration
        const durationPromises = analysisFiles.map(async (file) => {
            try {
                const [content] = await transcriptBucket.file(file.name).download({ start: 0, end: 199 });
                const header = content.toString('utf-8');
                const match = header.match(/^Duration:\s*(.+)$/m);
                return match ? match[1].trim() : null;
            } catch {
                return null;
            }
        });
        const durations = await Promise.all(durationPromises);

        const videos = [];
        analysisFiles.forEach((file, idx) => {
            // "video.mp4_ANALYSIS.txt" -> "video.mp4"
            const videoName = file.name.replace(/_ANALYSIS\.txt$/, '');
            const transcriptName = videoName + '_TRANSCRIPT.txt';
            const hasTranscript = fileNames.has(transcriptName);

            videos.push({
                videoName,
                analysisLink: `https://storage.cloud.google.com/${TRANSCRIPT_BUCKET}/${file.name}`,
                transcriptLink: hasTranscript ? `https://storage.cloud.google.com/${TRANSCRIPT_BUCKET}/${transcriptName}` : null,
                created: file.metadata.timeCreated,
                duration: durations[idx] || 'Unknown',
            });
        });

        // Sort by date (newest first)
        videos.sort((a, b) => new Date(b.created) - new Date(a.created));

        const html = generatePage(videos);
        res.send(html);

    } catch (err) {
        console.error('Editors dashboard error:', err);
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

function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function generatePage(videos) {
    const rows = videos.map((v, i) => `
        <tr>
            <td>${i + 1}</td>
            <td class="video-name">${escapeHtml(v.videoName)}</td>
            <td>${escapeHtml(v.duration)}</td>
            <td>${formatDate(v.created)}</td>
            <td>
                <a href="${v.analysisLink}" target="_blank" class="btn-link analysis">AI Analysis</a>
            </td>
            <td>
                ${v.transcriptLink ? `<a href="${v.transcriptLink}" target="_blank" class="btn-link transcript">Transcript</a>` : '<span class="na">N/A</span>'}
            </td>
        </tr>
    `).join('');

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Video Editors Dashboard</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
            min-height: 100vh;
            color: #e2e8f0;
            padding: 20px;
        }
        .container {
            max-width: 1000px;
            margin: 0 auto;
            padding-bottom: 60px;
        }
        header {
            text-align: center;
            padding: 40px 0 30px;
        }
        h1 {
            font-size: 2.2rem;
            margin-bottom: 8px;
            background: linear-gradient(90deg, #38bdf8, #a78bfa);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .subtitle {
            color: #94a3b8;
            font-size: 1rem;
        }
        .count-badge {
            display: inline-block;
            background: rgba(56, 189, 248, 0.15);
            border: 1px solid rgba(56, 189, 248, 0.3);
            color: #38bdf8;
            padding: 8px 24px;
            border-radius: 20px;
            font-size: 1rem;
            font-weight: 600;
            margin: 20px 0 30px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            background: rgba(255,255,255,0.05);
            border-radius: 12px;
            overflow: hidden;
        }
        th, td {
            padding: 14px 18px;
            text-align: left;
        }
        th {
            background: rgba(56, 189, 248, 0.15);
            font-weight: 600;
            text-transform: uppercase;
            font-size: 0.8rem;
            letter-spacing: 0.5px;
            color: #94a3b8;
        }
        tr:nth-child(even) {
            background: rgba(255,255,255,0.03);
        }
        tr:hover {
            background: rgba(56, 189, 248, 0.08);
        }
        .video-name {
            font-weight: 500;
            max-width: 350px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .btn-link {
            display: inline-block;
            padding: 6px 14px;
            border-radius: 6px;
            text-decoration: none;
            font-size: 0.85rem;
            font-weight: 600;
            transition: opacity 0.2s;
        }
        .btn-link:hover {
            opacity: 0.85;
            text-decoration: none;
        }
        .btn-link.analysis {
            background: rgba(74, 222, 128, 0.15);
            color: #4ade80;
            border: 1px solid rgba(74, 222, 128, 0.3);
        }
        .btn-link.transcript {
            background: rgba(56, 189, 248, 0.15);
            color: #38bdf8;
            border: 1px solid rgba(56, 189, 248, 0.3);
        }
        .na {
            color: #475569;
            font-size: 0.85rem;
        }
        .empty {
            text-align: center;
            padding: 60px 20px;
            color: #64748b;
            background: rgba(255,255,255,0.03);
            border-radius: 12px;
        }
        .refresh {
            text-align: center;
            margin-top: 30px;
            color: #475569;
            font-size: 0.85rem;
        }
        @media (max-width: 700px) {
            .video-name {
                max-width: 150px;
            }
            th, td {
                padding: 10px 8px;
                font-size: 0.85rem;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Video Editors Dashboard</h1>
            <p class="subtitle">AI Analysis & Transcripts</p>
        </header>

        <div style="text-align: center;">
            <span class="count-badge">${videos.length} video${videos.length !== 1 ? 's' : ''} processed</span>
        </div>

        ${videos.length === 0 ? `
            <div class="empty">
                <p>No videos with AI analysis yet.</p>
            </div>
        ` : `
            <table>
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Video</th>
                        <th>Duration</th>
                        <th>Processed</th>
                        <th>AI Analysis</th>
                        <th>Transcript</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
        `}

        <p class="refresh">Refresh page to see latest videos</p>
    </div>
</body>
</html>
    `;
}
