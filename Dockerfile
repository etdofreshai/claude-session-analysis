FROM node:22-alpine

RUN apk add --no-cache openssh-client rsync

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

RUN chmod +x /app/docker-entrypoint.sh \
    && mkdir -p /data/archive /data/.ssh \
    && chmod 700 /data/.ssh
ENV HOME=/data \
    CLAUDE_REMOTE_CACHE=/data/archive \
    CLAUDE_DISABLE_LOCAL=1 \
    SESSION_SSH_KEY_PATH=/data/.ssh/id_ed25519 \
    SESSION_SSH_KNOWN_HOSTS=/data/.ssh/known_hosts
VOLUME ["/data"]
EXPOSE 5180

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5180", "--strictPort"]
