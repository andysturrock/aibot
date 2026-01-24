# Deployment Guide

Deploying AIBot requires a Google Cloud Project and a Slack App.

## Prerequisites

- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) installed and authenticated.
- [Terraform](https://www.terraform.io/downloads.html) installed.
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

## 3. Secret Synchronization

The deployment relies on a `.env` file for sensitive tokens. 

1. Create a `.env` file based on `env.template`.
2. Populate the following critical values:
   - `slackBotToken`: Your Slack `xoxb-` token.
   - `slackSigningSecret`: From the Slack App "Basic Information" tab.
   - `iapClientId` / `iapClientSecret`: Created in the "APIs & Services > Credentials" page for the IAP OAuth client.
3. Sync secrets to GCP:
   ```bash
   ./scripts/deploy.sh --secrets-only
   ```

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

> [!TIP]
> Use the `--service [name]` flag to update individual components (e.g., `aibot-logic`, `slack-search-mcp`) without a full redeploy.
