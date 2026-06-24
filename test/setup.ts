// Runs before any test module is loaded.
import 'reflect-metadata';  // NestJS decorators on the imported controllers need this
import 'dotenv/config';     // so PrismaClient sees DATABASE_URL from .env
