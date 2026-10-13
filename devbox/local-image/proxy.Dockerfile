# The sandbox's only way out (devbox/local): tinyproxy, passing HTTPS to the allowed domains and nothing else.
FROM ubuntu:24.04
RUN apt-get update \
 && apt-get install -y --no-install-recommends tinyproxy \
 && rm -rf /var/lib/apt/lists/*
COPY local-image/proxy-start /usr/local/bin/proxy-start
RUN chmod 755 /usr/local/bin/proxy-start
USER nobody
ENTRYPOINT ["/usr/local/bin/proxy-start"]
