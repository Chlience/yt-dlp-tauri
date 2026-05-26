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

If a tool version changes, update both:

- `src-tauri/tools-manifest.json`
- `scripts/download-tools.ps1`

Use fixed release URLs and refreshed SHA-256 hashes. Do not use `latest` URLs in the production manifest.

## Pull Requests

Before opening a pull request:

1. Keep changes focused.
2. Run the verification commands above.
3. Update README files when behavior, setup, or release steps change.
4. Update `THIRD-PARTY-NOTICES.md` when tool sources or licensing notes change.
