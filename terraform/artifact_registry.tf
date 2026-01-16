resource "google_artifact_registry_repository" "aibot_images" {
  location      = var.gcp_region
  repository_id = "aibot-images"
  description   = "Docker repository for AIBot services"
  format        = "DOCKER"

  docker_config {
    immutable_tags = false
  }
}

output "artifact_registry_repo" {
  value = google_artifact_registry_repository.aibot_images.name
}
