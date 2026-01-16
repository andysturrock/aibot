FROM python:3.13-slim

WORKDIR /app

# Copy root configurations if any (monorepo root)
COPY python/pyproject.toml ./

# Copy the shared library
COPY python/libs/shared ./libs/shared

# Copy the service code
COPY python/services/aibot_logic ./services/aibot_logic

# Install dependencies
RUN pip install ./libs/shared
RUN pip install ./services/aibot_logic

WORKDIR /app/services/aibot_logic

ENV PORT=8080
EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
