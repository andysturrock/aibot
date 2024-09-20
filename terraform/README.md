# Roles and permissions needed for running Terraform
Best practice is to have a project which contains the Workload Identity Federation stuff and a different project for the main functionality.
These are referred to as the "identity" project and the "gemini" project in the terraform code.

Terraform needs the following roles and permissions to run in the identity project:
```
roles/Service Usage Admin
iam.roles.create
iam.roles.delete
iam.roles.get
iam.roles.update
iam.serviceAccounts.get
iam.workloadIdentityPoolProviders.create
iam.workloadIdentityPoolProviders.delete
iam.workloadIdentityPoolProviders.get
iam.workloadIdentityPools.create
iam.workloadIdentityPools.delete
iam.workloadIdentityPools.get
resourcemanager.projects.getIamPolicy
resourcemanager.projects.setIamPolicy
```

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
Need to manually download the ADC file from the workload identity pool to package with the AWS lambda.  This could probably be automated using the GCP CLI.