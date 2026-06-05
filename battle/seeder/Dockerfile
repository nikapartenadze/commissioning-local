# Built from battle/ context so the (git-ignored) seed DB can be baked in:
#   docker build -f seeder/Dockerfile .
# Locally seed/ comes from tools/prepare_seed.py; in CI it is downloaded from
# the GitLab generic package registry before the build.
FROM python:3.12-slim
COPY seeder/seed.py /scripts/seed.py
COPY seed/database.db /seed/database.db
CMD ["python", "/scripts/seed.py"]
