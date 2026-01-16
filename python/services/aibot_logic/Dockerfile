FROM python:3.13-slim

# Install system dependencies if needed (e.g., for some python packages)
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

# Copy the shared library
COPY python/libs/shared ./libs/shared

# Copy the service code
COPY python/services/aibot_logic ./services/aibot_logic

# Install dependencies into venv
RUN pip install --no-cache-dir ./libs/shared
RUN pip install --no-cache-dir ./services/aibot_logic

# Set ownership to the non-root user
RUN chown -R aibot:aibot /app /opt/venv

USER aibot

WORKDIR /app/services/aibot_logic

ENV PORT=8080
EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
