# @repo/npm-tarball

Installs a pinned npm platform tarball into a caller-owned cache directory. `ensureNpmTarball`
downloads through Effect's HTTP client, checks the SHA-512 integrity before extraction, validates
the caller's required files, and renames the extracted directory into place. Concurrent installs
of the same target share one process-wide flight. The caller supplies the release pin, validation,
archive subdirectory, and cache path; this package does not decide platform support or app data paths.

Consumers: `@repo/code-lsp` caches TypeScript 7's native executable and declaration files;
the desktop sidecar caches the microsandbox addon and runtime binaries on first sandbox use.
