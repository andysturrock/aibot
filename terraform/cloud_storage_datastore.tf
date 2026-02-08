# Create a bucket for the datastore
resource "google_storage_bucket" "aibot_search_datastore" {
  location                    = var.gcp_region
  name                        = "aibot_search_datastore_${random_id.name_suffix.hex}"
  force_destroy               = true
  uniform_bucket_level_access = true
  storage_class               = "STANDARD"
}

resource "google_discovery_engine_data_store" "aibot_search" {
  location                    = "eu"
  data_store_id               = "aibot_search_${random_id.name_suffix.hex}"
  display_name                = "AIBot search"
  industry_vertical           = "GENERIC"
  content_config              = "CONTENT_REQUIRED"
  solution_types              = ["SOLUTION_TYPE_SEARCH"]
  create_advanced_site_search = false

  document_processing_config {
    default_parsing_config {
      digital_parsing_config {}
    }
  }
}

# This is only really needed to turn on the enterprise features for the data store.
resource "google_discovery_engine_search_engine" "aibot" {
  engine_id      = "aibot-${random_id.name_suffix.hex}"
  collection_id  = "default_collection"
  location       = google_discovery_engine_data_store.aibot_search.location
  display_name   = "AIBot"
  data_store_ids = [google_discovery_engine_data_store.aibot_search.data_store_id]
  search_engine_config {
    search_tier    = "SEARCH_TIER_ENTERPRISE"
    search_add_ons = ["SEARCH_ADD_ON_LLM"]
  }
}

# Create a bucket for the datastore
resource "google_storage_bucket" "aibot_documents" {
  location                    = var.gcp_region
  name                        = "aibot_documents_${random_id.name_suffix.hex}"
  force_destroy               = true
  uniform_bucket_level_access = true
  storage_class               = "STANDARD"
}
# Create a dedicated Firestore database for AIBot
resource "google_firestore_database" "aibot_db" {
  project                     = var.gcp_gemini_project_id
  name                        = "aibot-db"
  location_id                 = var.gcp_region
  type                        = "FIRESTORE_NATIVE"
  concurrency_mode            = "OPTIMISTIC"
  app_engine_integration_mode = "DISABLED"
  delete_protection_state     = "DELETE_PROTECTION_DISABLED"
  deletion_policy             = "DELETE"
}
