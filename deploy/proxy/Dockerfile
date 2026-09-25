# The bundled reverse proxy (docker-compose.yml `proxy` service). Stock nginx
# plus openssl, which the alpine image lacks, for the first-start self-signed
# certificate. Build context is the repo root, like every other service.
FROM nginx:1.27-alpine
RUN apk add --no-cache openssl
COPY deploy/proxy/default.conf.template /etc/nginx/templates/default.conf.template
COPY --chmod=755 deploy/proxy/40-self-signed-cert.sh /docker-entrypoint.d/40-self-signed-cert.sh
