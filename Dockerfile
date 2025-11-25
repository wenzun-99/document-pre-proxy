# Use official Node 24 LTS image
FROM node:24.8.0-alpine

# Create app dir
WORKDIR /usr/src/app

# Install runtime deps
COPY package.json yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile


# Copy source
COPY src/ ./src/

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /usr/src/app
USER appuser

ENV NODE_ENV=production
ENV PORT=5000
ENV PAPERLESS_UPSTREAM=http://localhost:8001

EXPOSE 5000

CMD ["node", "src/upload_proxy.js"]
