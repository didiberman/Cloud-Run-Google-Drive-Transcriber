# AI Processing Feature Plan

## Overview

Add an AI processing step after transcription completes. Users can customize the AI behavior by placing a `PROMPT.md` file in a `_prompts` subfolder within the monitored Drive folder.

---

## Architecture

```
Google Drive (monitored folder)
├── _prompts/
│   └── PROMPT.md          ← User's custom prompt template
├── Meeting 1.mp4          ← Video files
├── Meeting 2.mp4
└── Subfolder/
    ├── _prompts/
    │   └── PROMPT.md      ← Override prompt for this subfolder
    └── Video.mp4
```

### Pipeline Flow

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ Drive Poller│───►│ Transcriber │───►│  Notifier   │───►│ AI Processor│
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
                                                                │
                                                                ▼
                                                         ┌─────────────┐
                                                         │Upload to    │
                                                         │Drive folder │
                                                         └─────────────┘
```

---

## Design Decisions

### 1. Where to Store Prompts

**Option A: `_prompts/PROMPT.md` subfolder** (Recommended)
- Clean separation from video files
- Folder name starts with `_` to sort first
- Can have multiple prompt files for different use cases later

**Option B: `PROMPT.md` in same folder**
- Simpler but clutters the video folder

### 2. Prompt Inheritance

```
Root folder PROMPT.md → Default for all videos
Subfolder PROMPT.md   → Overrides for that subfolder only
```

If no PROMPT.md exists, use a sensible default prompt.

### 3. Google AI Service Options

| Service | Pros | Cons |
|---------|------|------|
| **Vertex AI (Gemini)** | Native GCP, same billing, powerful | More complex setup |
| **Gemini API** | Simple REST API, easy to use | Separate API key needed |
| **Cloud Natural Language** | Good for entity extraction | Limited customization |

**Recommendation**: Vertex AI with Gemini 1.5 Flash (fast, cheap, 1M token context)

### 4. Output Format

Create two files in the same Drive folder as the video:
- `video-name.txt` - Raw transcript (already implemented)
- `video-name-ai-summary.md` - AI-processed output

---

## Implementation Plan

### Phase 1: Infrastructure Setup

1. **Enable Vertex AI API** in Terraform
   ```hcl
   "aiplatform.googleapis.com"
   ```

2. **Grant IAM permissions** to service account
   ```hcl
   roles/aiplatform.user
   ```

3. **Add environment variables**
   - `AI_MODEL`: Model to use (default: `gemini-1.5-flash`)
   - `AI_ENABLED`: Toggle feature on/off
   - `DEFAULT_PROMPT`: Fallback prompt if no PROMPT.md found

### Phase 2: Prompt Discovery

Add to `drive-poller`:
1. When downloading a video, also check for `_prompts/PROMPT.md` in:
   - Same folder as video
   - Parent folder (fallback)
   - Root monitored folder (final fallback)
2. Store prompt content (or "none") in file metadata

### Phase 3: AI Processor Function

**Option A: Extend notifier function**
- Add AI processing after transcript is ready
- Simpler, fewer moving parts

**Option B: New dedicated function** (Recommended)
- Triggered by transcript `.txt` file creation
- Cleaner separation of concerns
- Can retry AI independently of notifications

New function: `ai-processor`
- Trigger: GCS object finalized on `.txt` files in transcripts bucket
- Read transcript content
- Fetch prompt from metadata or default
- Call Vertex AI
- Upload result to Drive

### Phase 4: Vertex AI Integration

```javascript
const { VertexAI } = require('@google-cloud/vertexai');

const vertex = new VertexAI({
  project: process.env.GCP_PROJECT,
  location: 'us-central1'
});

const model = vertex.getGenerativeModel({
  model: 'gemini-1.5-flash-001'
});

async function processWithAI(transcript, prompt) {
  const fullPrompt = `${prompt}\n\n---\n\nTRANSCRIPT:\n${transcript}`;

  const result = await model.generateContent(fullPrompt);
  return result.response.text();
}
```

---

## Default Prompt Template

```markdown
You are an AI assistant that processes video transcripts.

Analyze the following transcript and provide:

1. **Summary** (2-3 paragraphs)
2. **Key Points** (bullet list)
3. **Action Items** (if any)
4. **Topics Discussed** (tags)

Be concise and focus on the most important information.
```

---

## Example Custom PROMPT.md

User could create `_prompts/PROMPT.md` with:

```markdown
This is a sales call recording. Please analyze and extract:

1. **Customer Name & Company**
2. **Pain Points Mentioned**
3. **Objections Raised**
4. **Next Steps Agreed**
5. **Deal Size/Timeline** (if mentioned)
6. **Sentiment** (positive/neutral/negative)

Format as a CRM-ready summary.
```

---

## Cost Estimates

| Component | Cost |
|-----------|------|
| Gemini 1.5 Flash | $0.075 per 1M input tokens, $0.30 per 1M output |
| Typical transcript (30 min video) | ~10K tokens = ~$0.001 |
| AI output | ~1K tokens = ~$0.0003 |

**Per video: ~$0.002** (very cheap)

---

## Terraform Changes Required

```hcl
# Enable Vertex AI
resource "google_project_service" "apis" {
  for_each = toset([
    # ... existing ...
    "aiplatform.googleapis.com"
  ])
}

# Grant AI permissions
resource "google_project_iam_member" "vertex_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.drive_poller_sa.email}"
}

# New function
resource "google_cloudfunctions2_function" "ai_processor" {
  name        = "ai-processor"
  location    = var.region
  description = "Processes transcripts with AI"

  # ... similar config to notifier ...

  event_trigger {
    event_type = "google.cloud.storage.object.v1.finalized"
    event_filters {
      attribute = "bucket"
      value     = google_storage_bucket.transcripts_bucket.name
    }
  }
}
```

---

## Variables to Add

```hcl
variable "ai_enabled" {
  description = "Enable AI processing of transcripts"
  type        = bool
  default     = true
}

variable "ai_model" {
  description = "Vertex AI model to use"
  type        = string
  default     = "gemini-1.5-flash-001"
}

variable "default_ai_prompt" {
  description = "Default prompt if no PROMPT.md found"
  type        = string
  default     = "Summarize this transcript with key points and action items."
}
```

---

## Open Questions

1. **Prompt file name**: `PROMPT.md` or `prompt.md` or `_prompt.md`?
2. **Multiple prompts**: Support `PROMPT-summary.md`, `PROMPT-actions.md` for different outputs?
3. **Token limits**: What if transcript exceeds context window? (Gemini 1.5 handles 1M tokens, unlikely to hit)
4. **Error handling**: What if AI fails? Retry? Skip? Notify?
5. **Rate limiting**: Process all at once or queue?

---

## Next Steps

1. [ ] Decide on prompt file naming convention
2. [ ] Enable Vertex AI API in GCP console (or via Terraform)
3. [ ] Create `ai-processor` function skeleton
4. [ ] Test Vertex AI integration locally
5. [ ] Update drive-poller to fetch prompt files
6. [ ] Deploy and test end-to-end
