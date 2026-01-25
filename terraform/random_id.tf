# Generate a random suffix as several things need to be unique, including:
# Bucket names (Need to be globally unique so can't create with the same name in different projects)
# Custom roles (as GCP soft deletes them)
# google_discovery_engine_data_store ids (as they take ages to delete so can't recreate with the same name quickly)
resource "random_id" "name_suffix" {
  byte_length = 2
}
