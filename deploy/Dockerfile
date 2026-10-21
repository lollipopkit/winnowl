# The backend runtime ships only bundled files + prompts + migrations, no node_modules
# (externalized native addons are optional and fall back to JS).

FROM node:26-alpine AS build
# No C/C++ toolchain: no dependency compiles native code (ssh2 / cpu-features come
# from testcontainers, a test-only dependency, and have pure-JS fallbacks; see onlyBuiltDependencies).
RUN apk add --no-cache git
RUN npm install -g pnpm@10.6.5
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
# The web build copies this JSON Schema into the site so the documented `$schema` URL resolves.
COPY config-schema ./config-schema
RUN pnpm install --frozen-lockfile
RUN pnpm -s exec tsc -b
# Build time only: prerendered canonical/og:url and sitemap.xml embed absolute URLs.
# Self-hosted builds pass --build-arg SITE_URL=https://<your domain>.
ARG SITE_URL=https://winnowl.lollipopkit.com
ENV VITE_SITE_URL=$SITE_URL
RUN pnpm --filter @reviewbot/web-console build
RUN node scripts/bundle-server.mjs

# go install pins versions without depending on release asset naming.
FROM golang:alpine AS scanners
RUN apk add --no-cache git
ARG OSV_SCANNER_VERSION=v1.9.2
ARG GITLEAKS_VERSION=v8.21.2
RUN GOBIN=/out go install github.com/google/osv-scanner/cmd/osv-scanner@${OSV_SCANNER_VERSION} \
 && GOBIN=/out go install github.com/zricethezav/gitleaks/v8@${GITLEAKS_VERSION}

FROM node:26-alpine AS backend
# semgrep has no static binary, hence pip. setuptools <81 is required: semgrep's opentelemetry deps
# import `pkg_resources`, removed in setuptools 81 (fails only at run time). Verify with `semgrep --version`.
RUN apk add --no-cache git docker-cli ca-certificates ripgrep py3-pip \
 && pip install --no-cache-dir --break-system-packages "setuptools<81" semgrep==1.97.0
# refresh-images.sh passes the date daily so the upgrade reruns while the slow layers above stay cached.
ARG ALPINE_REFRESH=unset
RUN echo "alpine refresh ${ALPINE_REFRESH}" && apk upgrade --no-cache
# Rules are baked in so the scan sandbox needs no route to semgrep.dev (below the refresh layer, so
# updated daily). Scanning an empty dir fails if semgrep cannot load them.
RUN mkdir -p /opt/semgrep /tmp/semgrep-check \
 && wget -qO /opt/semgrep/security-audit.yml https://semgrep.dev/c/p/security-audit \
 && HOME=/tmp semgrep scan --config /opt/semgrep/security-audit.yml --metrics=off --disable-version-check --quiet /tmp/semgrep-check \
 && rm -rf /tmp/semgrep-check /tmp/.semgrep
ENV SEMGREP_CONFIG=/opt/semgrep/security-audit.yml
COPY --from=scanners /out/osv-scanner /usr/local/bin/osv-scanner
COPY --from=scanners /out/gitleaks /usr/local/bin/gitleaks
# A new volume mounted here copies this mode, giving the non-root sandbox user write access.
RUN mkdir -m 1777 /workspace
WORKDIR /app
ENV NODE_ENV=production
# Bundles keep their original paths so relative prompts/migrations lookups resolve under /app.
COPY --from=build /app/dist-bundle/ ./
COPY prompts ./prompts
COPY migrations ./migrations
RUN printf '{"type":"module","name":"winnowl-runtime","private":true}\n' > package.json
CMD ["node", "apps/control-api/dist/index.mjs"]

FROM nginx:alpine AS web
COPY deploy/nginx/base/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web-console/dist /usr/share/nginx/html
