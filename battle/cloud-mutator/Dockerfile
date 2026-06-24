FROM postgres:14-alpine
# curl: API mode drives the cloud admin API (dev-admin sign-in + POST/DELETE).
# psql is already in the base image (SQL mode).
RUN apk add --no-cache curl
COPY mutate.sh /mutate.sh
RUN chmod +x /mutate.sh
ENTRYPOINT ["/mutate.sh"]
