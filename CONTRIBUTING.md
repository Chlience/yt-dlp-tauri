# Contributing

Thanks for taking the time to improve `yt-dlp-tauri`.

## Development Setup

Install dependencies:

```bash
npm install
```

Run the frontend build:

```bash
npm run build
```

Run Rust checks:

```bash
cargo test --manifest-path ./src-tauri/Cargo.toml --lib
cargo check --manifest-path ./src-tauri/Cargo.toml
```

For a real Windows installer, build on Windows with the MSVC Rust toolchain:

```powershell
npm run tauri build
```

## Tool Binaries

Do not commit restored or downloaded tool binaries. The repository intentionally ignores:

- `src-tauri/Tools/win-x64/`
- `src-tauri/Tools/.tmp/`
- `src-tauri/target/`
- `dist/`
- `node_modules/`

Tool metadata is generated from a reviewed policy. Do not hand-edit:

- `toolchain-lock.json`
- `src-tauri/tools-manifest.json`
- `TOOLCHAIN_CHANGELOG.md`

Change upstream sources or selection rules in `toolchain-policy.json`, then run a dry resolution:

```bash
GITHUB_TOKEN="$(gh auth token)" node scripts/update-toolchain.mjs --dry-run
```

The weekly workflow generates one combined pull request. Use `node scripts/update-toolchain.mjs --only <source-id>` only for a focused compatibility, security, or dead-URL repair. Generated manifests must use fixed release URLs and refreshed executable SHA-256 hashes.

Repository automation requires the `TOOLCHAIN_BOT_APP_ID` and `TOOLCHAIN_BOT_PRIVATE_KEY` secrets for the narrowly scoped GitHub App. Bot pull requests still require normal tests and maintainer review.

## Pull Requests

Before opening a pull request:

1. Keep changes focused.
2. Run the verification commands above.
3. Update README files when behavior, setup, or release steps change.
4. Update `THIRD-PARTY-NOTICES.md` when tool sources or licensing notes change.
