variable "project_id" {
  description = "The GCP Project ID to deploy to (e.g., didiberman or sams-project)"
  type        = string
}

variable "region" {
  description = "The GCP Region to deploy to"
  type        = string
  default     = "us-central1"
}

variable "drive_folder_id" {
  description = "The ID of the Google Drive folder to watch"
  type        = string
}

variable "notification_email" {
  description = "Email address to receive notifications (if using simple logging/emailing)"
  type        = string
  default     = ""
}

variable "gmail_user" {
  description = "Gmail address for sending notifications"
  type        = string
  default     = ""
}

variable "gmail_app_password" {
  description = "App Password for the Gmail account"
  type        = string
  default     = ""
}

variable "send_start_email" {
  description = "Whether to send 'Transcription Started' email (true/false)"
  type        = bool
  default     = true
}

variable "dashboard_password" {
  description = "Password for the public dashboard"
  type        = string
  default     = "tmptmp123"
}
