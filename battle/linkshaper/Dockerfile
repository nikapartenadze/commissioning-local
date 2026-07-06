# Link-shaper: tiny stdlib-only TCP latency/bandwidth/loss proxy for the
# tool↔cloud link (the "slow/terrible internet" scenario).
FROM python:3.12-slim
WORKDIR /app
COPY shaper.py .
# LISTEN_PORT / UPSTREAM / SHAPE_* set via compose env.
CMD ["python", "-u", "shaper.py"]
