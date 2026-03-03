#!/bin/bash
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd "$(dirname "$0")"
npm run tauri dev
