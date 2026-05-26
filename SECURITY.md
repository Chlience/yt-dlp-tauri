# Security Policy

## Supported Versions

Security fixes target the latest commit on `main` until the project starts publishing versioned releases.

## Reporting a Vulnerability

Please do not open a public issue for a suspected vulnerability.

Report security issues through GitHub private vulnerability reporting if it is enabled for the repository. If it is not enabled, contact the maintainer through the GitHub profile linked from the repository owner.

Include:

- A short description of the issue.
- Reproduction steps.
- Affected platform and version.
- Whether third-party tools from `src-tauri/tools-manifest.json` are involved.

## Toolchain Integrity

The app installs third-party tools from fixed release URLs and verifies extracted executables with SHA-256. Changes to tool URLs or hashes should be reviewed as security-sensitive changes.
