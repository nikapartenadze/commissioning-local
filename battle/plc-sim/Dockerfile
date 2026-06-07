# ============================================================================
# plc-sim — patched libplctag ab_server posing as the site ControlLogix.
#
# Built from libplctag v2.6.16 (the last release that ships src/tools/ab_server;
# v2.7.0 dropped it for the unfinished ab_server_fiber poc). Patched so tag
# names may contain ':' and '.' and so multi-segment symbolic requests match
# flat names — see patch_ab_server.py.
#
# Restarting this container == a PLC program download: connection drop + every
# tag back to zero (ab_server state is in-memory only). That is exactly the
# semantics the tool's flag-restore path must survive.
# ============================================================================
FROM debian:trixie-slim AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends git cmake make g++ ca-certificates python3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 --branch v2.6.16 https://github.com/libplctag/libplctag.git

COPY patch_ab_server.py /tmp/patch_ab_server.py
RUN python3 /tmp/patch_ab_server.py /src/libplctag/src/tools/ab_server

WORKDIR /src/libplctag/build
RUN cmake .. -DCMAKE_BUILD_TYPE=Release -DBUILD_EXAMPLES=0 \
 && make ab_server -j"$(nproc)" \
 && find . -name ab_server -type f -executable -exec cp {} /ab_server \;

# ---- runtime ----------------------------------------------------------------
FROM debian:trixie-slim
COPY --from=build /ab_server /usr/local/bin/ab_server
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
# EtherNet/IP
EXPOSE 44818
ENTRYPOINT ["/entrypoint.sh"]
