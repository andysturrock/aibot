terraform {
  backend "gcs" {
    bucket = "PROJECT_ID_PLACEHOLDER-terraform-state"
    prefix = "terraform/state/aibot-atom-dev"
  }
}