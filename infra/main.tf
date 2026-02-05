# Enable necessary APIs
resource "google_project_service" "apis" {
  for_each = toset([
    "drive.googleapis.com",
    "cloudfunctions.googleapis.com",
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "speech.googleapis.com",
    "storage.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudscheduler.googleapis.com",
    "iam.googleapis.com",
    "eventarc.googleapis.com",
    "pubsub.googleapis.com",
    "videointelligence.googleapis.com"
  ])
  project            = var.project_id
  service            = each.key
  disable_on_destroy = false
}

# ------------------------------------------------------------------------------
# Storage Buckets
# ------------------------------------------------------------------------------

# Random suffix to ensure unique bucket names
resource "random_id" "bucket_suffix" {
  byte_length = 4
}

# Bucket for uploading Function Source Code
resource "google_storage_bucket" "source_bucket" {
  name                        = "${var.project_id}-function-source-${random_id.bucket_suffix.hex}"
  location                    = var.region
  uniform_bucket_level_access = true
}

# Bucket for Input Audio (Drive Poller uploads here)
resource "google_storage_bucket" "audio_input_bucket" {
  name                        = "${var.project_id}-audio-input-${random_id.bucket_suffix.hex}"
  location                    = var.region
  uniform_bucket_level_access = true
}

# Bucket for Transcripts (Transcriber outputs here)
resource "google_storage_bucket" "transcripts_bucket" {
  name                        = "${var.project_id}-transcripts-${random_id.bucket_suffix.hex}"
  location                    = var.region
  uniform_bucket_level_access = true
}

# Grant read access to transcripts bucket for the notification recipient
resource "google_storage_bucket_iam_member" "transcripts_viewer" {
  bucket = google_storage_bucket.transcripts_bucket.name
  role   = "roles/storage.objectViewer"
  member = "user:${var.gmail_user}"
}

# ------------------------------------------------------------------------------
# Service Account for Drive Poller
# ------------------------------------------------------------------------------
resource "google_service_account" "drive_poller_sa" {
  account_id   = "drive-bot"
  display_name = "Drive Automation Bot"
  project      = var.project_id
}

# Grant Eventarc permissions to the SA (Required for GCS Triggers in Gen 2)
resource "google_project_iam_member" "eventarc_receiver" {
  project = var.project_id
  role    = "roles/eventarc.eventReceiver"
  member  = "serviceAccount:${google_service_account.drive_poller_sa.email}"
}

# Grant Cloud Run Invoker (Required for Eventarc to call the Function)
resource "google_project_iam_member" "run_invoker" {
  project = var.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.drive_poller_sa.email}"
}

# Grant Log Writer (Always good for functions)
resource "google_project_iam_member" "log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.drive_poller_sa.email}"
}

# Grant Storage Admin (So it can Read/Write from buckets)
resource "google_project_iam_member" "storage_admin" {
  project = var.project_id
  role    = "roles/storage.admin"
  member  = "serviceAccount:${google_service_account.drive_poller_sa.email}"
}

# Fix for "Failed to update storage bucket metadata"
# The GCS Service Agent needs permission to publish to Pub/Sub for Eventarc
data "google_storage_project_service_account" "gcs_account" {
}

resource "google_project_iam_member" "gcs_pubsub_publisher" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${data.google_storage_project_service_account.gcs_account.email_address}"
}
