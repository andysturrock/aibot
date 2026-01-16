terraform {
  backend "gcs" {
    bucket = "__TF_STATE_BUCKET__"
    prefix = "terraform/state/__TF_ENV__"
  }
}