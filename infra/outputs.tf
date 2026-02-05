output "service_account_email" {
  value       = google_service_account.drive_poller_sa.email
  description = "The email of the Service Account. Share the Google Drive folder with this email."
}

output "dashboard_url" {
  value       = google_cloudfunctions2_function.dashboard.service_config[0].uri
  description = "URL of the private dashboard (requires Google login)"
}
