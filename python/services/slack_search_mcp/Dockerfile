FROM python:3.13-slim

WORKDIR /app

# Copy root configurations
COPY python/pyproject.toml ./

# Copy and install shared library
COPY python/libs/shared ./libs/shared
RUN pip install ./libs/shared

# Copy and install search_mcp service
COPY python/services/slack_search_mcp ./services/slack_search_mcp
RUN pip install ./services/slack_search_mcp

WORKDIR /app/services/slack_search_mcp

EXPOSE 8080

# Run with uvicorn
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
