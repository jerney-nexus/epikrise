FROM mcr.microsoft.com/devcontainers/rust:1-bookworm

USER root

# Keep these Debian 12 browser dependencies aligned with the Playwright version in pnpm-lock.yaml.
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
    fonts-freefont-ttf \
    fonts-ipafont-gothic \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-tlwg-loma-otf \
    fonts-unifont \
    fonts-wqy-zenhei \
    gstreamer1.0-libav \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libatomic1 \
    libavcodec59 \
    libavif15 \
    libcairo-gobject2 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdbus-glib-1-2 \
    libdrm2 \
    libegl1 \
    libenchant-2-2 \
    libepoxy0 \
    libevdev2 \
    libevent-2.1-7 \
    libfontconfig1 \
    libfreetype6 \
    libgbm1 \
    libgdk-pixbuf-2.0-0 \
    libgles2 \
    libglib2.0-0 \
    libglx0 \
    libgstreamer-gl1.0-0 \
    libgstreamer-plugins-base1.0-0 \
    libgstreamer1.0-0 \
    libgtk-3-0 \
    libgtk-4-1 \
    libgudev-1.0-0 \
    libharfbuzz-icu0 \
    libharfbuzz0b \
    libhyphen0 \
    libicu72 \
    libjpeg62-turbo \
    liblcms2-2 \
    libmanette-0.2-0 \
    libnotify4 \
    libnspr4 \
    libnss3 \
    libopengl0 \
    libopenjp2-7 \
    libopus0 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libpng16-16 \
    libproxy1v5 \
    libsecret-1-0 \
    libsoup-3.0-0 \
    libwayland-client0 \
    libwayland-egl1 \
    libwayland-server0 \
    libwebp7 \
    libwebpdemux2 \
    libwoff1 \
    libx11-6 \
    libx11-xcb1 \
    libxcb-shm0 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxkbcommon0 \
    libxml2 \
    libxrandr2 \
    libxrender1 \
    libxslt1.1 \
    libxtst6 \
    pkg-config \
    patchelf \
    tesseract-ocr \
    tesseract-ocr-deu \
    tesseract-ocr-eng \
    xfonts-scalable \
    xvfb \
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
