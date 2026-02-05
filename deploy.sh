#!/bin/bash
set -e

echo "==================================================="
echo "   Deploying Sam's Google Drive Automation"
echo "==================================================="

# Ensure we are in the root
cd "$(dirname "$0")"

# Check for gcloud auth
echo "[1/3] Checking gcloud auth..."
gcloud auth print-access-token > /dev/null || { echo "Please run 'gcloud auth login' and 'gcloud auth application-default login' first."; exit 1; }

# Install dependencies for functions locally (optional, but good for lockfiles)
# echo "Installing Node deps..."
# (cd src/drive-poller && npm install)
# (cd src/transcriber && npm install)
# (cd src/notifier && npm install)

# Infrastructure
echo "[2/3] Initializing Terraform..."
cd infra
terraform init

echo "[3/3] Applying Infrastructure..."
echo "Note: You might be asked to confirm. Make sure terraform.tfvars has the correct Project ID and Folder ID."
terraform apply

echo "==================================================="
echo "   Deployment Complete!"
echo "   Please follow the Walkthrough to test."
echo "==================================================="
