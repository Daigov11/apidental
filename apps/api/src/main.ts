import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { loadEnvFile } from './config/load-env-file.js';

loadEnvFile();

const { AppConfig } = await import('./config/app-config.js');
const { AppModule } = await import('./app.module.js');
const { configureApp, createLogger, API_PREFIX } = await import('./app.setup.js');

async function bootstrap() {
  const config = new AppConfig(); // falla al iniciar si el entorno es inválido
  const app = await NestFactory.create(AppModule, { logger: createLogger(config), bufferLogs: true });
  configureApp(app, config);
  await app.listen(config.port, config.host);
  new Logger('Bootstrap').log(
    `ApiDental API escuchando en http://${config.host}:${config.port}/${API_PREFIX} (${config.nodeEnv})`,
  );
}
await bootstrap();
