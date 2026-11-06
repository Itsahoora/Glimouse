# Changelog

## v0.1.1

- Improved tracking and camera lifecycle reliability, including worker timeouts, termination, and fresh-worker recovery after failures.
- Hardened native mouse commands with session generations, sequence fencing, durable state checks, and fail-closed button-release handling.
- Expanded frontend and native command-state tests for worker recovery, session safety, persistence failures, and cleanup paths.
- Updated GitHub Actions to run the frontend checks and native command-state tests before publishing build artifacts or releases.
