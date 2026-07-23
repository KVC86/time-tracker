import 'dotenv/config';
import 'reflect-metadata';
import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Security headers (HSTS, X-Frame-Options, nosniff, Referrer-Policy, ...).
  // CSP is left off so it can't break the bundled public/ frontend; add a tuned
  // policy once the frontend's asset origins are pinned down.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.useStaticAssets(join(process.cwd(), 'public'));
  // Base64 image attachments (Sick/Emergency supporting docs, profile photos)
  // travel in JSON request bodies; the default ~100kb cap is too small for real
  // photos, so allow larger JSON payloads.
  app.useBodyParser('json', { limit: '10mb' });
  // Same-origin frontend needs no CORS. Cross-origin callers must be named via
  // WEB_ORIGIN; in production, refuse the wildcard rather than defaulting open.
  const webOrigin =
    process.env.WEB_ORIGIN?.trim() ||
    (process.env.NODE_ENV === 'production' ? false : '*');
  app.enableCors({ origin: webOrigin });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Time Tracker API running on http://localhost:${port}`);
}
bootstrap();
