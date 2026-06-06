.PHONY: help install install-hooks test test-cov lint lint-fix format format-check \
        tf-fmt tf-fmt-check tf-init deploy deploy-secrets check clean

.DEFAULT_GOAL := help

# Guard to require ENV for deploy/terraform targets
guard-env:
ifndef ENV
	$(error ENV is required. Usage: make <target> ENV=beta or ENV=prod)
endif

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Install all dependencies
	uv sync --all-groups

install-hooks: ## Install pre-commit and pre-push git hooks
	pre-commit install
	pre-commit install --hook-type pre-push

test: ## Run tests
	uv run pytest -v --color=yes --log-cli-level=INFO \
		--ignore=python/tests/integration_test.py

test-cov: ## Run tests with coverage (75% minimum)
	uv run pytest -v --color=yes --log-cli-level=INFO \
		--ignore=python/tests/integration_test.py \
		--cov=python/services/slack_search_mcp/main \
		--cov=python/services/aibot_logic/main \
		--cov=python/services/slack_collector/main \
		--cov=python/libs/shared \
		--cov=python/tools/mcp_proxy \
		--cov-report=term-missing \
		--cov-fail-under=75

lint: ## Check Python code with ruff
	uv run ruff check .

lint-fix: ## Auto-fix Python lint issues
	uv run ruff check --fix .

format: ## Format Python code with ruff
	uv run ruff format .

format-check: ## Check Python code formatting
	uv run ruff format --check .

tf-fmt: ## Format Terraform files
	terraform fmt -recursive terraform/

tf-fmt-check: ## Check Terraform formatting
	terraform fmt -check -recursive terraform/

tf-init: guard-env ## Init Terraform (requires ENV=beta|prod)
	terraform/init.sh --env=$(ENV)

deploy: guard-env ## Full deploy (requires ENV=beta|prod)
	scripts/deploy.sh --env=$(ENV)

deploy-secrets: guard-env ## Secrets-only deploy (requires ENV=beta|prod)
	scripts/deploy.sh --env=$(ENV) --secrets-only

check: lint format-check tf-fmt-check test ## Run all checks (lint, format, terraform, tests)

clean: ## Remove Python cache and build artifacts
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .pytest_cache -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .ruff_cache -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name "*.pyc" -delete 2>/dev/null || true
