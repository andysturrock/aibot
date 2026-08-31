resource "google_kms_key_ring" "aibot_keyring" {
  name     = "aibot-keyring"
  location = var.gcp_region
  project  = var.gcp_gemini_project_id

  depends_on = [google_project_service.cloudkms_api]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key" "token_encryption_key" {
  name            = "aibot-token-encryption-key"
  key_ring        = google_kms_key_ring.aibot_keyring.id
  rotation_period = "7776000s" # 90 days

  lifecycle {
    prevent_destroy = true
  }
}

output "token_encryption_key_path" {
  description = "Full resource path of the token encryption KMS key"
  value       = google_kms_crypto_key.token_encryption_key.id
}
