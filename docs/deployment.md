# Deployment Guide

Deploying AIBot requires a Google Cloud Project and a Slack App.

## Prerequisites

- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) installed and authenticated.
- [Terraform](https://www.terraform.io/downloads.html) installed.
- [SOPS](https://github.com/getsops/sops) (Secrets Operations) installed (for secure manual deployments).
- A Slack Workspace where you have permission to create apps.

---

## 1. Infrastructure Provisioning (GCP)

AIBot uses Terraform to manage all resources (Cloud Run, Pub/Sub, Firestore, IAM).

1. **Initialize Terraform**:
   ```bash
   cd terraform
   terraform init
   ```

2. **Configure Variables**:
   Create a `terraform.tfvars` file (or provide values when prompted) with your project details:
   - `project_id`: Your GCP Project ID.
   - `region`: (e.g., `europe-west2`).
   - `custom_fqdn`: The domain where your app will be hosted.

3. **Apply**:
   ```bash
   terraform apply
   ```

---

## 2. Slack App Configuration

Use the provided manifest template to configure your Slack App.

1. Go to [Slack App Management](https://api.slack.com/apps).
2. Create a **New App** -> **From a manifest**.
3. Copy the contents of `manifests/slack.json`.
4. Replace `aibot.example.com` with your actual FQDN from step 1.
5. Install the app to your workspace.

---

## 3. Secret Synchronization (Manual Deployment)

For manual deployments using `deploy.sh`, it is highly recommended to encrypt your `.env` files using **SOPS** to prevent secrets from accidentally being tracked or left in plaintext.

1. Create a `.env.beta` or `.env.prod` file based on `env.template`.
2. Populate the sensitive values (Slack tokens, IAP credentials, etc.).
3. **Encrypt Locally** (One-time setup per project):
   ```bash
   # 1. Create a KMS key for encryption (e.g., London region)
   gcloud kms keyrings create [YOUR_KEYRING_NAME] --location europe-west2
   gcloud kms keys create sops-key --location europe-west2 --keyring [YOUR_KEYRING_NAME] --purpose encryption

   # 2. Configure .sops.yaml (this file is ignored by Git)
   # creation_rules:
   #   - path_regex: \.env\.(beta|prod)$
   #     gcp_kms: projects/[PROJECT_ID]/locations/europe-west2/keyRings/[YOUR_KEYRING_NAME]/cryptoKeys/sops-key

   # 3. Generate the encrypted file
   sops -e .env.beta > .env.beta.enc
   ```
   > **Note**: While SOPS-encrypted files are cryptographically safe to commit to version control, the policy for this project is to **KEEP ALL .env files (plaintext or encrypted) UNTRACKED** to minimize any potential exposure.
4. **Cleanup Plaintext**:
   Delete your plaintext `.env.beta` or `.env.prod` files immediately after encryption to ensure they are never accidentally exposed.
5. **Sync to GCP**:
   ```bash
   ./scripts/deploy.sh --env=beta --secrets-only
   ```
   > **How it works**: `deploy.sh` detects the `.enc` file, creates a temporary secure file (`chmod 600`), sources it, and deletes it immediately using a trap, ensuring no plaintext remains after the sync.

---

## 4. Google OAuth Setup

To allow users to search their own history, the bot requires Google authentication.

1. **Configure OAuth Screen**: In the GCP Console, configure your OAuth Consent Screen.
2. **Add Scopes**: Ensure `openid`, `https://www.googleapis.com/auth/userinfo.email`, and `https://www.googleapis.com/auth/userinfo.profile` are added.
3. **Redirect URL**: Add `https://YOUR_FQDN/auth/callback/google` to your authorized redirect URIs in the Google Cloud Console.

---

## 5. Service Deployment

Once infrastructure and secrets are ready, deploy the services:

```bash
./scripts/deploy.sh --service all
```

> Use the `--service [name]` flag to update individual components (e.g., `aibot-logic`, `slack-search-mcp`) without a full redeploy.

---

## 6. GitHub CI/CD Pipeline Setup

AIBot uses GitHub Actions for automated linting, testing, and deployment.

### 1. Provision WIF Resources
Workload Identity Federation (WIF) allows GitHub Actions to authenticate to GCP without long-lived keys.
The required resources are managed in `terraform/github_actions.tf`.

Run the bootstrap deployment locally to create the WIF Pool and Provider:
```bash
./scripts/deploy.sh
```

### 2. Configure GitHub Environments
1. In your GitHub repository, go to **Settings > Environments**.
2. Create two environments: `beta` and `prod`.

### 3. Add Secrets
For each environment (`beta` and `prod`), add the following **Environment Secrets**:

- `GCP_SA_EMAIL`: The email of the `github-actions` service account (get from Terraform output).
- `GCP_WIF_PROVIDER`: The full path to the WIF Provider (get from Terraform output).
- `GCP_PROJECT_ID`: Your GCP Project ID for that environment.
- `GCP_REGION`: The GCP region (e.g., `europe-west2`).

### 4. Triggering Deployments
- **Beta**: Pushes to the `beta` branch will deploy to the project configured in the `beta` environment.
- **Production**: Pushes or merges to the `main` branch will deploy to the project configured in the `prod` environment.
