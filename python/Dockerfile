# Inherit from our optimized base image (pre-warmed with OS deps and venv)
FROM aibot-base:latest

# Define the service to build
ARG SERVICE_NAME
ENV SERVICE_NAME=${SERVICE_NAME}

# STEP 1: CACHE EXTERNAL DEPENDENCIES
# We copy ONLY the pyproject.toml first.
# As long as this file doesn't change, the pip install layer below is CACHED by Docker.
COPY --chown=aibot:aibot python/services/${SERVICE_NAME}/pyproject.toml /app/services/${SERVICE_NAME}/

# Using a cache mount to persist downloads on the host filesystem.
# We extraction deps from pyproject.toml, stripping out the local 'shared' lib which we handle next.
RUN --mount=type=cache,target=/home/aibot/.cache/pip,uid=999,gid=999 \
  pip install $(python3 -c "import tomllib; print(' '.join(tomllib.load(open('/app/services/${SERVICE_NAME}/pyproject.toml', 'rb'))['project']['dependencies']))" | sed 's/shared//g')

# STEP 2: CACHE SHARED LIBRARY
# This layer invalidates ONLY when files in python/libs/shared change.
COPY --chown=aibot:aibot python/libs/shared /app/libs/shared
RUN --mount=type=cache,target=/home/aibot/.cache/pip,uid=999,gid=999 \
  pip install ./libs/shared

# STEP 3: INSTALL SERVICE CODE
# This layer invalidates on ANY change to the service code (the most frequent trigger).
COPY --chown=aibot:aibot python/services/${SERVICE_NAME} /app/services/${SERVICE_NAME}

# Final install (installs the package itself without re-installing deps)
RUN pip install --no-deps ./services/${SERVICE_NAME}

# Set the working directory to the service
WORKDIR /app/services/${SERVICE_NAME}

# Expose the Cloud Run port
ENV PORT=8080
EXPOSE 8080

# Start the service
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port 8080"]
