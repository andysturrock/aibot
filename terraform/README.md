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
iam.roles.create
iam.roles.delete
iam.roles.get
iam.roles.update
iam.serviceAccounts.get
resourcemanager.projects.get
resourcemanager.projects.getIamPolicy
resourcemanager.projects.setIamPolicy
```

### TODO
Need to manually download the ADC file from the workload identity pool to package with the AWS lambda.  This could probably be automated using the GCP CLI.