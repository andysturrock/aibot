# Create a bucket
resource "google_storage_bucket" "aibot_search_datastore" {
  location                    = "EU"
  name                        = "aibot-search-datastore"
  force_destroy               = true
  uniform_bucket_level_access = true
  storage_class               = "STANDARD"
}

resource "google_discovery_engine_data_store" "aibot_search" {
  location                    = "eu"
  data_store_id               = "aibot_search"
  display_name                = "AIBot search"
  industry_vertical           = "GENERIC"
  content_config              = "CONTENT_REQUIRED"
  solution_types              = ["SOLUTION_TYPE_SEARCH"]
  create_advanced_site_search = false
}

# This is only really needed to turn on the enterprise features for the data store.
resource "google_discovery_engine_search_engine" "aibot" {
  engine_id      = "aibot"
  collection_id  = "default_collection"
  location       = google_discovery_engine_data_store.aibot_search.location
  display_name   = "AIBot"
  data_store_ids = [google_discovery_engine_data_store.aibot_search.data_store_id]
  search_engine_config {
    search_tier    = "SEARCH_TIER_ENTERPRISE"
    search_add_ons = ["SEARCH_ADD_ON_LLM"]
  }
}