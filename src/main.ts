import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { randomUUID, webcrypto } from 'node:crypto';

// Ensure global crypto exists (Node 18 on some platforms may lack globalThis.crypto)
// This avoids crashes in libraries that expect crypto.randomUUID()
const g: any = globalThis as any;
if (!g.crypto) {
  g.crypto = webcrypto as any;
}
if (!g.crypto.randomUUID) {
  g.crypto.randomUUID = randomUUID as any;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
