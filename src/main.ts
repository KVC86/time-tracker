import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useStaticAssets(join(process.cwd(), 'public'));
  // Base64 image attachments (Sick/Emergency supporting docs, profile photos)
  // travel in JSON request bodies; the default ~100kb cap is too small for real
  // photos, so allow larger JSON payloads.
  app.useBodyParser('json', { limit: '10mb' });
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? '*' });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Time Tracker API running on http://localhost:${port}`);
}
bootstrap();
