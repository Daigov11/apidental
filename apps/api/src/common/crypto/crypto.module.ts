import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';
import {
  AesGcmFieldCipher,
  type FieldCipher,
  parseKeyring,
  PassthroughFieldCipher,
} from './field-cipher.js';

export const FIELD_CIPHER = Symbol('FIELD_CIPHER');

/**
 * Provee el cifrador de campos según la configuración. En 3.2 NINGÚN servicio lo usa todavía: está disponible para
 * activar el cifrado por campo más adelante (ver `field-cipher.ts` y la documentación de 3.2).
 */
@Global()
@Module({
  providers: [
    {
      provide: FIELD_CIPHER,
      inject: [AppConfig],
      useFactory: (config: AppConfig): FieldCipher => {
        const { mode, keyId, key, oldKeys } = config.fieldEncryption;
        if (mode === 'off') return new PassthroughFieldCipher();
        return new AesGcmFieldCipher(keyId, {
          ...parseKeyring(oldKeys ?? undefined),
          [keyId]: Buffer.from(key!, 'base64'),
        });
      },
    },
  ],
  exports: [FIELD_CIPHER],
})
export class CryptoModule {}
