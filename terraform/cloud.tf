terraform {
  cloud {
    organization = "sturrock"

    workspaces {
      project = "aibot"
      tags = ["aibot-prod"]
    }
  }
}