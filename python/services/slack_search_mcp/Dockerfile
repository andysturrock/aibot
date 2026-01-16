FROM python:3.13-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
  build-essential \
  && rm -rf /var/lib/apt/lists/*

# Create a non-root user
RUN groupadd -r aibot && useradd -r -g aibot aibot

WORKDIR /app

# Setup virtual environment
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy root configurations
COPY python/pyproject.toml ./

# Copy and install shared library
COPY python/libs/shared ./libs/shared
RUN pip install --no-cache-dir ./libs/shared

# Copy and install search_mcp service
COPY python/services/slack_search_mcp ./services/slack_search_mcp
RUN pip install --no-cache-dir ./services/slack_search_mcp

# Set ownership to the non-root user
RUN chown -R aibot:aibot /app /opt/venv

USER aibot

WORKDIR /app/services/slack_search_mcp

EXPOSE 8080

# Run with uvicorn
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
