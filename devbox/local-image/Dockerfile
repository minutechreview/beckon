# The sandbox devbox/local runs Claude Code and devbox/chain in: Ubuntu 24.04 with Node, git, Claude Code and the
# beckon helper, and a user with no sudo. Built by devbox/local from the devbox/ directory. Guide: docs/devbox.md
FROM ubuntu:24.04
ARG BECKON_URL=https://beckoncli.com
ARG EXTRA_APT=""
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git jq ripgrep less unzip build-essential python3 \
 && install -d -m 755 /etc/apt/keyrings \
 && curl -fsSL --retry 3 https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /etc/apt/keyrings/nodesource.asc \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_22.x nodistro main" >/etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs $EXTRA_APT \
 && rm -rf /var/lib/apt/lists/*

# Changes on every `devbox/local build`, so the layers below fetch the latest Claude Code and helper.
ARG UPDATED=0
# Installed as root, outside the user's home: the agent can't change its own tools, and the image updates them.
RUN npm install -g @anthropic-ai/claude-code@latest && npm cache clean --force
RUN curl -fsSL --retry 3 "$BECKON_URL/install.sh" | BECKON_INSTALL_DIR=/usr/local/bin sh

COPY chain /usr/local/bin/beckon-chain
COPY local-image/start /usr/local/bin/devbox-start
RUN chmod 755 /usr/local/bin/beckon-chain /usr/local/bin/devbox-start \
 && useradd -m -s /bin/bash dev \
 && install -d -o dev -g dev /work

USER dev
WORKDIR /home/dev
# Claude Code updates with the image, and sends nothing but its API calls.
ENV DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
ENTRYPOINT ["/usr/local/bin/devbox-start"]
CMD ["shell"]
