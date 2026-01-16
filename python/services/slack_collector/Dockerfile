FROM python:3.12-slim

WORKDIR /app

# Copy root configurations if any (e.g. pyproject.toml)
COPY python/pyproject.toml ./

# Copy and install shared library
COPY python/libs/shared ./libs/shared
RUN pip install ./libs/shared

# Copy and install collector service
COPY python/services/slack_collector ./services/slack_collector
RUN pip install ./services/slack_collector

WORKDIR /app/services/slack_collector

EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
