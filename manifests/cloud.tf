terraform {
  cloud {
    organization = "__TF_ORG__"

    workspaces {
      project = "__TF_PROJECT__"
      tags = ["__TF_ENV__"]
    }
  }
}