# Built from battle/ context so the (git-ignored) seed DB can be baked in:
#   docker build -f seeder/Dockerfile .
# Locally seed/ comes from tools/prepare_seed.py (MCM02) and
# tools/prepare_cdw5_seed.py (the 19-MCM CDW5 production dump); in CI the
# MCM02 seed is downloaded from the GitLab generic package registry before
# the build. SEED_DB env selects which database the seeder uses.
FROM python:3.12-slim
COPY seeder/seed.py /scripts/seed.py
COPY seed/ /seed/
CMD ["python", "/scripts/seed.py"]
