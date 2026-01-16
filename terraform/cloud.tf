terraform {
  backend "gcs" {
    bucket = "your-gcp-project-id-terraform-state"
    prefix = "terraform/state/aibot-atom-dev"
  }
}