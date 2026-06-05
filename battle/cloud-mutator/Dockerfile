FROM postgres:14-alpine
COPY mutate.sh /mutate.sh
RUN chmod +x /mutate.sh
ENTRYPOINT ["/mutate.sh"]
