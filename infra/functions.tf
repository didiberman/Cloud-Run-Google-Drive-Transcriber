# ------------------------------------------------------------------------------
# 1. Drive Poller (Scheduled / HTTP)
# ------------------------------------------------------------------------------

# Zip the source code
data "archive_file" "drive_poller_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../src/drive-poller"
  output_path = "${path.module}/dist/drive-poller.zip"
}

# Upload zip to bucket
resource "google_storage_bucket_object" "drive_poller_zip" {
  name   = "drive-poller-${data.archive_file.drive_poller_zip.output_md5}.zip"
  bucket = google_storage_bucket.source_bucket.name
  source = data.archive_file.drive_poller_zip.output_path
}

# Cloud Function (Gen 2)
resource "google_cloudfunctions2_function" "drive_poller" {
  name        = "drive-poller"
  location    = var.region
  description = "Polls Google Drive for new files"

  build_config {
    runtime     = "nodejs22"
    entry_point = "pollDrive"
    source {
      storage_source {
        bucket = google_storage_bucket.source_bucket.name
        object = google_storage_bucket_object.drive_poller_zip.name
      }
    }
  }

  service_config {
    max_instance_count = 1
    available_memory   = "256M"
    timeout_seconds    = 60
    environment_variables = {
      FOLDER_ID   = var.drive_folder_id
      DEST_BUCKET = google_storage_bucket.audio_input_bucket.name
    }
    service_account_email = google_service_account.drive_poller_sa.email
  }
}

# Cloud Scheduler (Run every 5 mins)
resource "google_cloud_scheduler_job" "poller_trigger" {
  name        = "trigger-drive-poller"
  description = "Triggers the drive poller every 5 mins"
  schedule    = "*/5 * * * *"
  region      = var.region

  http_target {
    http_method = "POST"
    uri         = google_cloudfunctions2_function.drive_poller.service_config[0].uri

    oidc_token {
      service_account_email = google_service_account.drive_poller_sa.email
    }
  }
}

# ------------------------------------------------------------------------------
# 2. Transcriber (GCS Trigger)
# ------------------------------------------------------------------------------

data "archive_file" "transcriber_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../src/transcriber"
  output_path = "${path.module}/dist/transcriber.zip"
}

resource "google_storage_bucket_object" "transcriber_zip" {
  name   = "transcriber-${data.archive_file.transcriber_zip.output_md5}.zip"
  bucket = google_storage_bucket.source_bucket.name
  source = data.archive_file.transcriber_zip.output_path
}

resource "google_cloudfunctions2_function" "transcriber" {
  name        = "transcriber"
  location    = var.region
  description = "Transcribes audio files from GCS"

  build_config {
    runtime     = "nodejs22"
    entry_point = "transcribeAudio"
    source {
      storage_source {
        bucket = google_storage_bucket.source_bucket.name
        object = google_storage_bucket_object.transcriber_zip.name
      }
    }
  }

  service_config {
    max_instance_count = 10
    available_memory   = "512M"
    timeout_seconds    = 540 # 9 mins (Speech API can take time)
    environment_variables = {
      TRANSCRIPT_BUCKET  = google_storage_bucket.transcripts_bucket.name
      NOTIFICATION_EMAIL = var.notification_email
      GMAIL_USER         = var.gmail_user
      GMAIL_APP_PASSWORD = var.gmail_app_password
    }
  }

  event_trigger {
    trigger_region        = var.region
    event_type            = "google.cloud.storage.object.v1.finalized"
    retry_policy          = "RETRY_POLICY_RETRY"
    service_account_email = google_service_account.drive_poller_sa.email # Reusing SA for simplicity, or create new one
    event_filters {
      attribute = "bucket"
      value     = google_storage_bucket.audio_input_bucket.name
    }
  }
}

# ------------------------------------------------------------------------------
# 3. Notifier (GCS Trigger)
# ------------------------------------------------------------------------------

data "archive_file" "notifier_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../src/notifier"
  output_path = "${path.module}/dist/notifier.zip"
}

resource "google_storage_bucket_object" "notifier_zip" {
  name   = "notifier-${data.archive_file.notifier_zip.output_md5}.zip"
  bucket = google_storage_bucket.source_bucket.name
  source = data.archive_file.notifier_zip.output_path
}

resource "google_cloudfunctions2_function" "notifier" {
  name        = "notifier"
  location    = var.region
  description = "Sends notifications when transcript is ready"

  build_config {
    runtime     = "nodejs22"
    entry_point = "sendNotification"
    source {
      storage_source {
        bucket = google_storage_bucket.source_bucket.name
        object = google_storage_bucket_object.notifier_zip.name
      }
    }
  }

  service_config {
    max_instance_count = 5
    available_memory   = "256M"
    environment_variables = {
      NOTIFICATION_EMAIL = var.notification_email
      GMAIL_USER         = var.gmail_user
      GMAIL_APP_PASSWORD = var.gmail_app_password
      TRANSCRIPT_BUCKET  = google_storage_bucket.transcripts_bucket.name
      INPUT_BUCKET       = google_storage_bucket.audio_input_bucket.name
    }
  }

  event_trigger {
    trigger_region        = var.region
    event_type            = "google.cloud.storage.object.v1.finalized"
    retry_policy          = "RETRY_POLICY_RETRY"
    service_account_email = google_service_account.drive_poller_sa.email
    event_filters {
      attribute = "bucket"
      value     = google_storage_bucket.transcripts_bucket.name
    }
  }
}
