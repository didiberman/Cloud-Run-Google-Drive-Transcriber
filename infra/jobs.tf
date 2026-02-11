# ------------------------------------------------------------------------------
# Cloud Run Job: Large File Downloader
# ------------------------------------------------------------------------------

# The image URL. We'll use a placeholder or "latest" tag.
# NOTE: You must build/push this image at least once for the Job to deploy successfully.
# gcloud builds submit --tag REGION-docker.pkg.dev/PROJECT/REPO/large-downloader ../src/large-downloader
locals {
  image_name = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.repo.repository_id}/large-downloader:latest"
}

resource "google_cloud_run_v2_job" "large_downloader" {
  name     = "drive-large-downloader"
  location = var.region

  template {
    template {
      max_retries = 3
      timeout     = "86400s" # 24 hours (Max for Cloud Run Jobs)

      containers {
        image = local.image_name

        resources {
          limits = {
            cpu    = "1000m"
            memory = "2Gi" # 2GB RAM to be safe with large streams
          }
        }

        # Env vars are passed as overrides when triggering, 
        # but we can set defaults or placeholders here.
        env {
          name  = "UseConcurrentHandlers"
          value = "true"
        }
      }

      service_account = google_service_account.drive_poller_sa.email
    }
  }

  lifecycle {
    ignore_changes = [
      launch_stage,
    ]
  }
}

# Grant the Drive Poller SA permission to trigger this Job
resource "google_cloud_run_v2_job_iam_member" "job_runner" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.large_downloader.name
  role     = "roles/run.developer" # Permission to run/execute the job
  member   = "serviceAccount:${google_service_account.drive_poller_sa.email}"
}

# Also need Viewer role to get the job status/details if using the client library?
# Usually jobRunner is enough to 'run', but let's add Viewer just in case.
resource "google_cloud_run_v2_job_iam_member" "job_viewer" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.large_downloader.name
  role     = "roles/run.viewer"
  member   = "serviceAccount:${google_service_account.drive_poller_sa.email}"
}
