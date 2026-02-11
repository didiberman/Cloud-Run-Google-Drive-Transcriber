#!/bin/bash
set -e

# Configuration
PROJECT_ID="sam-drive-automation"
REGION="us-central1"
REPO_NAME="drive-automation-repo"
IMAGE_NAME="large-downloader"

echo "========================================================"
echo "Deploying Large File Support (Cloud Run Job)"
echo "========================================================"

# 1. First, apply Terraform to create the Artifact Registry Repo
# We target just the repo first to ensure it exists before we try to push to it
echo "Step 1: Creating Artifact Registry Repository..."
cd infra
terraform apply -target=google_artifact_registry_repository.repo -auto-approve
cd ..

# 2. Build and Push the Docker image using Cloud Build
# This avoids needing local Docker
echo "Step 2: Building and Pushing Docker Image..."
IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${IMAGE_NAME}:latest"
echo "Target Image: ${IMAGE_URI}"

gcloud builds submit src/large-downloader \
  --tag "${IMAGE_URI}" \
  --project "${PROJECT_ID}"

# 3. Apply the rest of the Terraform (Job, Functions updates)
echo "Step 3: Deploying Cloud Run Job and Updating Functions..."
cd infra
terraform apply -auto-approve
cd ..

echo "========================================================"
echo "Deployment Complete!"
echo "========================================================"
