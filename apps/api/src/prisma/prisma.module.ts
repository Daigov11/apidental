import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';
import { createPrismaClient, type PrismaDb } from './client.js';

export const PRISMA = Symbol('PRISMA');

@Global()
@Module({
  providers: [
    {
      provide: PRISMA,
      inject: [AppConfig],
      useFactory: (config: AppConfig): PrismaDb => createPrismaClient(config.databaseUrl),
    },
  ],
  exports: [PRISMA],
})
export class PrismaModule implements OnApplicationShutdown {
  constructor(@Inject(PRISMA) private readonly db: PrismaDb) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.$disconnect();
  }
}
