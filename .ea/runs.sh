# --------------------------------------------------------------------------------------------------------
# hapi
# hapi: http://localhost:3006/
# internal: http://localhost:3007/
# --------------------------------------------------------------------------------------------------------
# version internal
cd .ea/repos/_tx/tencent-hapi
# version hapi
cd packages/hapi

cd web
bun install
bun run build

cd hub && bun run generate:embedded-web-assets


