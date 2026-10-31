FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils curl findutils git procps \
      python3 python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages \
      pandas requests openpyxl matplotlib python-docx

WORKDIR /opt/browserd
COPY browserd/package.json browserd/package-lock.json ./
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/* /root/.npm
COPY browserd/server.mjs ./

# uid 1000 занят пользователем node базового образа.
RUN useradd --create-home --uid 1001 --shell /bin/bash agent \
 && mkdir -p /workspace \
 && chown agent:agent /workspace

USER agent
WORKDIR /workspace
CMD ["node", "/opt/browserd/server.mjs"]
