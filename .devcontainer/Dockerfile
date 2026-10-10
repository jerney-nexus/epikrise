FROM mcr.microsoft.com/devcontainers/rust:1-bookworm

USER root

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential \
    clang \
    curl \
    file \
    lld \
    llvm \
    ninja-build \
    nsis \
    libssl-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libwebkit2gtk-4.1-dev \
    libxdo-dev \
    pkg-config \
    patchelf \
    tesseract-ocr \
    tesseract-ocr-deu \
    tesseract-ocr-eng \
  && restart_manager_temp="$(mktemp)" \
  && curl --fail --location --silent --show-error \
    "https://raw.githubusercontent.com/NSIS-Dev/NSIS/v312/Include/Win/RestartManager.nsh" \
    -o "$restart_manager_temp" \
  && printf '%s  %s\n' \
    "67149978412da9b283e2e1abe48a360093df9caf6363373e2cabe463978b7c0e" \
    "$restart_manager_temp" | sha256sum --check --status \
  && install -D -m 0644 "$restart_manager_temp" \
    /usr/share/nsis/Include/Win/RestartManager.nsh \
  && rm -f "$restart_manager_temp" \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

USER vscode

RUN rustup component add clippy rustfmt llvm-tools-preview \
  && cargo install cargo-nextest --locked \
  && cargo install cargo-llvm-cov --locked \
  && cargo install cargo-audit --locked \
  && cargo install cargo-deny --locked \
  && cargo install cargo-xwin --version 0.23.1 --locked
