# Base Image for AIBot Python Services
# This image caches OS dependencies, the virtual environment, and the shared library
FROM python:3.13-slim

# Install OS dependencies
# We use a cache mount for apt to speed up iterative builds
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt,sharing=locked \
  apt-get update && apt-get install -y --no-install-recommends \
  build-essential \
  libpq-dev \
  && rm -rf /var/lib/apt/lists/*

# Create a non-root user with a home directory
RUN groupadd -r aibot && useradd -m -r -g aibot aibot

# Setup application directory
WORKDIR /app
RUN chown aibot:aibot /app

# Switch to non-root user
USER aibot

# Setup Virtual Environment
ENV VENV_PATH=/home/aibot/venv
RUN python -m venv $VENV_PATH
ENV PATH="$VENV_PATH/bin:$PATH"

# Pre-install common tools
RUN --mount=type=cache,target=/home/aibot/.cache/pip,uid=999,gid=999 \
  pip install --upgrade pip setuptools wheel

# Setup Environment Variables
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
