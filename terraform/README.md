# Roles and permissions needed for running Terraform

Terraform manages all bot infrastructure in a single GCP project (the "gemini" project).


Terraform needs the following roles and permissions to run in the gemini project:
```
roles/Service Usage Admin
roles/Artifact Registry Writer
secretmanager.secrets.getIamPolicy
secretmanager.secrets.setIamPolicy
bigquery.datasets.create
bigquery.jobs.create
cloudfunctions.functions.create
cloudfunctions.functions.delete
cloudfunctions.functions.update
cloudfunctions.operations.get
cloudfunctions.functions.get
cloudfunctions.functions.getIamPolicy
cloudscheduler.jobs.create
cloudscheduler.jobs.enable
cloudscheduler.jobs.get
cloudscheduler.jobs.delete
cloudscheduler.jobs.update
run.services.getIamPolicy
run.services.setIamPolicy
iam.roles.create
iam.roles.delete
iam.roles.get
iam.roles.update
iam.serviceAccounts.get
iam.serviceAccounts.create
resourcemanager.projects.get
resourcemanager.projects.getIamPolicy
resourcemanager.projects.setIamPolicy
storage.buckets.create
storage.buckets.get
storage.buckets.delete
storage.objects.create
storage.objects.delete
storage.objects.get
storage.objects.list
discoveryengine.dataStores.create
discoveryengine.dataStores.get
discoveryengine.dataStores.delete
discoveryengine.engines.create
discoveryengine.engines.get
discoveryengine.engines.delete
```

### TODO
Explore automating the population of required secrets in GCP Secret Manager using a script or Terraform providers.
