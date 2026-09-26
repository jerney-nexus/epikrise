#!/usr/bin/env bash
# Linux build dependencies for Tauri v2, plus the OCR toolchain used by epikrise-ingest.
# See https://v2.tauri.app/start/prerequisites/
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  build-essential \
  curl \
  file \
  wget \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libwebkit2gtk-4.1-dev \
  libxdo-dev \
  pkg-config \
  patchelf \
  tesseract-ocr \
  tesseract-ocr-deu \
  tesseract-ocr-eng

sudo apt-get clean
sudo rm -rf /var/lib/apt/lists/*

rustup component add clippy rustfmt
