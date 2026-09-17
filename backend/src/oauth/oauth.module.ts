import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { OAuthPayload } from "./entities/oauth-payload.entity";
import { OauthInstanceConfig } from "./entities/oauth-instance-config.entity";
import { OauthSigningKeysService } from "./oauth-signing-keys.service";
import { EncryptionModule } from "../common/encryption/encryption.module";
import { OAuthProviderService } from "./oauth-provider.service";
import { OAuthInteractionController } from "./oauth-interaction.controller";
import { OAuthMetadataController } from "./oauth-metadata.controller";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([OAuthPayload, OauthInstanceConfig]),
    AuthModule,
    EncryptionModule,
  ],
  providers: [OAuthProviderService, OauthSigningKeysService],
  controllers: [OAuthInteractionController, OAuthMetadataController],
  exports: [OAuthProviderService],
})
export class OAuthModule {}
