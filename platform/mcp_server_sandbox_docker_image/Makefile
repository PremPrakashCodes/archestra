PYTHON_VERSION := 3.12

# `--universal` resolves the lockfile to satisfy every supported platform,
# emitting per-platform hashes for binary wheels. The resulting
# `requirements.lock` works for both `linux/amd64` and `linux/arm64`
# builds — the multi-arch CI workflow (.github/workflows/
# build-base-mcp-sandbox-docker-image.yml) builds both, and `uv pip
# install --require-hashes` picks the right wheel hash at install time.
.PHONY: update-python-lockfile
update-python-lockfile:
	uv pip compile \
		pyproject.toml \
		--python-version $(PYTHON_VERSION) \
		--universal \
		--generate-hashes \
		--output-file requirements.lock
