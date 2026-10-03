#!/bin/bash
# Same resource/build owner as release; debug builds disable automatic updates.
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_ONLY=false
DSH_SOURCE="release"
DSH_HANDOFF=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --build-only) BUILD_ONLY=true; shift ;;
        --dsh-source) DSH_SOURCE="${2:-}"; shift 2 ;;
        --dsh-handoff) DSH_HANDOFF="${2:-}"; shift 2 ;;
        --help|-h) echo "Usage: ./build_dev_linux.sh [--build-only] [--dsh-source release|local] [--dsh-handoff /absolute/path]"; exit 0 ;;
        *) echo "Unsupported option: $1" >&2; exit 1 ;;
    esac
done
if [ "$DSH_SOURCE" = "local" ]; then
    "${PROJECT_DIR}/build_linux.sh" --debug --dsh-source local --dsh-handoff "$DSH_HANDOFF"
else
    "${PROJECT_DIR}/build_linux.sh" --debug
fi
if [ "$BUILD_ONLY" = true ]; then exit 0; fi
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    echo "Build succeeded. Start the development executable from an Ubuntu desktop session."
    exit 0
fi
# Do not kill installed apps or other development sessions. The app's existing
# single-instance owner decides whether a second process may run.
cd "$PROJECT_DIR"
exec "${PROJECT_DIR}/src-tauri/target/x86_64-unknown-linux-gnu/debug/myagents"
