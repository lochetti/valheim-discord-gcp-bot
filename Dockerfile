FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    lib32gcc-s1 \
    python3 \
    curl \
    ca-certificates \
    gnupg \
    procps \
    && curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-get update && apt-get install -y google-cloud-cli \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/steamcmd && \
    curl -sqL "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz" | tar zxvf - -C /opt/steamcmd

RUN /opt/steamcmd/steamcmd.sh \
    +force_install_dir /opt/valheim \
    +login anonymous \
    +app_update 896660 validate \
    +quit

RUN mkdir -p /opt/valheim/worlds

COPY scripts/stop.sh /opt/valheim/stop.sh
COPY scripts/shutdown-server.py /opt/valheim/shutdown-server.py
COPY scripts/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /opt/valheim/stop.sh /entrypoint.sh

EXPOSE 2456-2458/udp
EXPOSE 8080/tcp

ENTRYPOINT ["/entrypoint.sh"]
