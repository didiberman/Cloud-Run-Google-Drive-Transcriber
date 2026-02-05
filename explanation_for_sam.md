# How This Project Works - Explanation for Sam

## What It Does

This is an automated video transcription pipeline. You drop a video into a Google Drive folder, and it automatically:
1. Transcribes the speech to text
2. Runs AI analysis on the transcript (using Gemini or Claude)
3. Emails you the results

No manual intervention needed after setup.

## The Flow

```
Google Drive folder
       ↓ (checked every 2 minutes)
Drive Poller downloads video to cloud storage
       ↓
Transcriber sends to Google's Video Intelligence API
       ↓ (30 min to 1+ hour depending on video length)
Notifier receives transcript, runs AI analysis
       ↓
Email sent with transcript + analysis attached
```

## The 4 Cloud Functions

| Function | What It Does |
|----------|--------------|
| **Drive Poller** | Watches your Drive folder, downloads new videos (max 3 hours long) |
| **Transcriber** | Sends video to Google's speech-to-text API |
| **Notifier** | Formats transcript, runs AI analysis, sends email |
| **Dashboard** | Web UI to view transcripts and configure AI prompts |

## Key Tech

- **Google Cloud Functions** - runs the code (serverless, pay-per-use)
- **Google Cloud Storage** - stores videos and transcripts
- **Video Intelligence API** - does the actual speech-to-text
- **Vertex AI** - runs AI analysis (Gemini or Claude models)
- **Terraform** - deploys everything with one command

## Dashboard

Access at: `https://dashboard-xxx.run.app?p=YOUR_PASSWORD`

You can:
- See all processed transcripts
- Download transcript/analysis files
- Change the AI prompt for future videos
- Select which AI model to use (Gemini Flash, Gemini Pro, Claude Sonnet, Claude Opus)

## Deployment

1. Fill out `terraform.tfvars` with your GCP project, Drive folder ID, and Gmail credentials
2. Run `./deploy.sh`
3. Share the Drive folder with the service account email (gives it access)
4. Done - just upload videos to the folder

## Scalability & Reliability

The system is highly scalable and reliable because each function runs for only seconds (starting async jobs then exiting), Google's backend handles the heavy lifting, and event-driven triggers automatically chain the steps together—so you can process many videos in parallel without any single function timing out or failing.

## Limitations

- Videos must be under 3 hours (API limit)
- English only (hardcoded)
- Processing takes 30+ minutes for longer videos
