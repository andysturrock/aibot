# Parameterized Dockerfile for Python Services
ARG SERVICE_NAME

FROM python:3.13-slim

# Install system dependencies (needed for some cloud SDKs/native extensions)
RUN apt-get update && apt-get install -y --no-install-recommends \
  build-essential \
  && rm -rf /var/lib/apt/lists/*

# Create a non-root user for security
RUN groupadd -r aibot && useradd -r -g aibot aibot

WORKDIR /app

# Setup virtual environment to avoid root permission warnings and isolate dependencies
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy monorepo configurations
COPY python/pyproject.toml ./

# Copy the shared internal library
COPY python/libs/shared ./libs/shared

# Copy the specific service code (using the SERVICE_NAME argument)
ARG SERVICE_NAME
COPY python/services/${SERVICE_NAME} ./services/${SERVICE_NAME}

# Install shared and service dependencies into the venv
RUN pip install --no-cache-dir ./libs/shared
RUN pip install --no-cache-dir ./services/${SERVICE_NAME}

# Set ownership to the non-root user
RUN chown -R aibot:aibot /app /opt/venv

USER aibot

# Switch to the service directory
WORKDIR /app/services/${SERVICE_NAME}

ENV PORT=8080
EXPOSE 8080

# Execute service using uvicorn
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
