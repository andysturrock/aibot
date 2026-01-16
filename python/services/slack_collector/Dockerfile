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

# Copy root configurations (e.g. pyproject.toml)
COPY python/pyproject.toml ./

# Copy and install shared library
COPY python/libs/shared ./libs/shared
RUN pip install --no-cache-dir ./libs/shared

# Copy and install collector service
COPY python/services/slack_collector ./services/slack_collector
RUN pip install --no-cache-dir ./services/slack_collector

# Set ownership to the non-root user
RUN chown -R aibot:aibot /app /opt/venv

USER aibot

WORKDIR /app/services/slack_collector

EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
