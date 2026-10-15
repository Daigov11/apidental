import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { AppConfig } from '../config/app-config.js';
import { AttachmentsController } from './attachments.controller.js';
import { AttachmentsService } from './attachments.service.js';
import { ConsentsController } from './consents.controller.js';
import { ConsentsService } from './consents.service.js';
import { DuplicatesService } from './duplicates.service.js';
import { LocalFileStorage } from './files/local-file-storage.js';
import { GuardiansController } from './guardians.controller.js';
import { GuardiansService } from './guardians.service.js';
import { PatientsController } from './patients.controller.js';
import { PatientsService } from './patients.service.js';

@Module({
  imports: [
    MulterModule.registerAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        // Sin `storage`, multer retiene el archivo en memoria (con límite estricto); el servicio lo
        // persiste luego en disco privado. Nunca se guarda en MySQL.
        // Los navegadores envían el nombre del archivo en UTF-8; el valor por defecto (latin1) corrompe tildes y ñ.
        defParamCharset: 'utf8',
        limits: { fileSize: config.attachments.maxBytes, files: 1, fields: 8, fieldSize: 2_048, parts: 10 },
      }),
    }),
  ],
  controllers: [PatientsController, GuardiansController, ConsentsController, AttachmentsController],
  providers: [PatientsService, DuplicatesService, GuardiansService, ConsentsService, AttachmentsService, LocalFileStorage],
})
export class PatientsModule {}
