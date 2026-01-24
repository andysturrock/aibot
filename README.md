# AIBot: The AI-Powered Slack Intelligence Assistant

AIBot is a high-performance, modular Slack bot that leverages Google Vertex AI (Gemini) and the Model Context Protocol (MCP) to provide intelligent answers from your organization's internal knowledge.

## Core Features

- 🧠 **Context-Aware Conversations**: Native support for Slack threads with persistent session memory.
- 🔍 **Semantic Search**: Search deep into Slack archives using vector embeddings (BigQuery Vector Search).
- 🔐 **Secure by Design**: Verified Slack signatures, Google OAuth identity integration, and Identity-Aware Proxy (IAP) protection.
- ⚡ **Optimised UX**: Humorous "Keep Alive" feedback loop and parallelized search for maximum responsiveness.
- 🛠️ **Modular Architecture**: Easy to extend with new agents or data sources using MCP.

---

## 📚 Documentation Suite

For a deep dive into how AIBot works and how to set it up, please refer to the following guides:

- **[System Architecture](docs/architecture.md)**: Explore the modular microservices, Pub/Sub flow, and agent hierarchy.
- **[Deployment Guide](docs/deployment.md)**: Step-by-step instructions for GCP, Terraform, and Slack configuration.
- **[UX & Design Decisions](docs/ux-and-design.md)**: Understanding our philosophy on responsiveness, continuity, and performance.

---

## 🚀 Quick Start (Local Development)

### 1. Requirements
- Python 3.11+
- Google Cloud Project with Billing Enabled

### 2. Environment Setup
Copy the template and fill in your local development secrets:
```bash
cp env.template .env
```

### 3. Running Services
Each service is a FastAPI application. To run the logic worker locally:
```bash
cd python/services/aibot_logic
pip install -r requirements.txt
python main.py
```

---

## Contributing

We welcome contributions! Please see our development guidelines in the [UX & Design](docs/ux-and-design.md) docs for more context on the codebase structure.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
