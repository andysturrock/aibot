terraform {
  backend "gcs" {
    bucket = "ab-ai-test-392416-terraform-state"
    prefix = "terraform/state/aibot-atom-dev"
  }
}