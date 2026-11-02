import { nginxCspTemplate } from './csp.ts';

// bun apps/web/nginx-csp.ts > csp.conf.template — стадия сборки docker/nginx/Dockerfile.
process.stdout.write(nginxCspTemplate());
